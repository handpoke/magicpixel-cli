import { describe, expect, it } from 'vitest';
import { matchGlob } from '../src/util/globMatch.js';
import { normalizeConnectGlob, tidyConnectGlobs, unwatchedHiddenFolders } from '../src/util/engineConnect.js';
import { whyConnectCommand } from '../src/commands/why.js';

const entry = (sourceRel: string) => ({ abs: `/x/${sourceRel}`, sourceRel, adoptRel: sourceRel, key: sourceRel.toLowerCase() });

describe('connect pattern cleanup', () => {
  it('fixes the broken leftovers from a merged setup', () => {
    expect(normalizeConnectGlob('kr-core//Runtime/Sprites/Entities/decorations')).toBe('kr-core/Runtime/Sprites/Entities/decorations');
    expect(normalizeConnectGlob('kr-core/Runtime/**~')).toBe('kr-core/Runtime/**');
  });

  it('drops duplicates and patterns a broader folder already covers', () => {
    expect(tidyConnectGlobs([
      'kr-core/Runtime/Sprites/Icons/**',
      'kr-core/Runtime/**~',
      'kr-core//Runtime/Sprites/Entities/decorations',
      'kr-core/Runtime/Sprites/Entities/decorations/**',
      'kr-remote-bundles/Characters/**',
    ])).toEqual(['kr-core/Runtime/**', 'kr-remote-bundles/Characters/**']);
  });

  it('rabbit/** covers rabbit files but not rabbit_nft', () => {
    const g = 'kr-remote-bundles/.SpineRaw/rabbit/**';
    expect(matchGlob('kr-remote-bundles/.SpineRaw/rabbit/agent/arm.png', g)).toBe(true);
    expect(matchGlob('kr-remote-bundles/.SpineRaw/rabbit_nft/poseidon/body_front.png', g)).toBe(false);
  });

  it('flags unwatched hidden art folders', () => {
    const files = Array.from({ length: 12 }, (_, i) => entry(`kr-remote-bundles/.SpineRaw/rabbit/a/p${i}.png`));
    expect(unwatchedHiddenFolders(files, new Set())).toEqual([['kr-remote-bundles/.SpineRaw/rabbit', 12]]);
    expect(unwatchedHiddenFolders(files, new Set(files.map((f) => f.key)))).toEqual([]);
  });

  it('never suggests an excluded hidden folder', () => {
    const files = Array.from({ length: 12 }, (_, i) => entry(`kr-remote-bundles/.SpineRaw/rabbit_nft/p/x${i}.png`));
    expect(unwatchedHiddenFolders(files, new Set(), ['kr-remote-bundles/.SpineRaw/rabbit_nft/**'])).toEqual([]);
  });

  it('why on a single file suggests its folder', () => {
    const rel = 'kr-remote-bundles/.SpineRaw/rabbit/agent/arm.png';
    expect(whyConnectCommand(rel, rel.toLowerCase())).toContain("connect 'kr-remote-bundles/.SpineRaw/rabbit/agent/**'");
  });

  it('why prints a ready-to-run connect command for the folder asked about', () => {
    expect(whyConnectCommand('kr-remote-bundles/.SpineRaw/rabbit/agent/arm.png', 'kr-remote-bundles/.spineraw/rabbit'))
      .toContain("connect 'kr-remote-bundles/.SpineRaw/rabbit/**'");
  });
});

import { COMMAND_TIPS, formatHelpTips } from '../src/util/commandTips.js';
describe('command tips', () => {
  it('help lists every shared tip', () => {
    const help = formatHelpTips();
    for (const t of COMMAND_TIPS) expect(help).toContain(`magicpixel ${t.run}`);
  });
});
