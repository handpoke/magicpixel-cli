import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadState, statePath } from '../src/config.js';

/**
 * loadConfig must surface friendly, multi-line errors for hand-edited
 * magicpixel.json files with the wrong shape. These cases used to throw
 * cryptic TypeErrors deep in glob matching.
 */
describe('loadConfig shape validation', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mp-cfg-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(json: string) {
    await writeFile(join(dir, 'magicpixel.json'), json, 'utf8');
  }

  it('rejects top-level array', async () => {
    await write('[]');
    await expect(loadConfig(dir)).rejects.toThrow(/must be a JSON object/);
  });

  it('rejects include as string', async () => {
    await write(JSON.stringify({ include: '**/*' }));
    await expect(loadConfig(dir)).rejects.toThrow(/"include" must be an array/);
  });

  it('rejects emitIndex as string', async () => {
    await write(JSON.stringify({ emitIndex: 'true' }));
    await expect(loadConfig(dir)).rejects.toThrow(/"emitIndex" must be a boolean/);
  });

  it('rejects outDir with parent-traversal segment', async () => {
    await write(JSON.stringify({ outDir: '../escape' }));
    await expect(loadConfig(dir)).rejects.toThrow(/outDir must not contain/);
  });

  it('accepts a well-formed config', async () => {
    await write(JSON.stringify({ outDir: 'src/assets/mp', include: ['**/*'], emitIndex: false }));
    const cfg = await loadConfig(dir);
    expect(cfg.outDir).toBe('src/assets/mp');
    expect(cfg.emitIndex).toBe(false);
  });
});

describe('loadState corrupt-quarantine recovery', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mp-state-'));
    await mkdir(join(dir, '.magicpixel'), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('moves a corrupt state.json aside and falls back to {} (so the CLI never wedges)', async () => {
    const sPath = statePath(dir);
    await writeFile(sPath, 'not json {', 'utf8');
    const warn = (() => { const orig = console.warn; console.warn = () => {}; return orig; })();
    try {
      const state = await loadState(dir);
      expect(state).toEqual({});
    } finally {
      console.warn = warn;
    }
    // The original file must be gone — quarantined under a sibling name.
    expect(existsSync(sPath)).toBe(false);
    const siblings = await readdir(join(dir, '.magicpixel'));
    expect(siblings.some((n) => n.startsWith('state.json.corrupt-'))).toBe(true);
  });
});
