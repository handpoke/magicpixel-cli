import { afterEach, describe, expect, it } from 'vitest';
import { canRedraw, card, errorCard, fitLine, spinner, wrapLine, icon, isPlain, progressBar, setPlain, ui, visibleWidth } from '../src/util/ui.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;
const EMOJI = /[\u{1F000}-\u{1FFFF}\u2600-\u27BF\u23F1\u23F3\u23F8\u2B07\u2B06]/u;

afterEach(() => {
  setPlain(false);
  delete process.env.MAGICPIXEL_PLAIN;
});

describe('terminal look', () => {
  it('plain mode has no colors, emoji or box drawing', () => {
    setPlain(true);
    expect(isPlain()).toBe(true);
    const out = [
      ui.ok('done'), ui.warn('careful'), ui.fail('broke'), ui.fix('magicpixel login'), ui.dryRun(),
      card('Sync complete', [`${icon('down')} 3 downloaded`]), progressBar(5, 10), errorCard('Oops\n  Fix: run it'),
    ].join('\n');
    expect(out).not.toMatch(ANSI);
    expect(out).not.toMatch(EMOJI);
    expect(out).not.toMatch(/[╭╮╰╯│█]/);
  });

  it('NO_COLOR-style env turns on plain mode', () => {
    process.env.MAGICPIXEL_PLAIN = '1';
    expect(isPlain()).toBe(true);
  });

  it('cards never get wider than the terminal', () => {
    const tty = process.stdout.isTTY;
    const ci = process.env.CI;
    const noColor = process.env.NO_COLOR;
    const term = process.env.TERM;
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    process.stdout.isTTY = true;
    try {
    const out = card('Sync complete', ['x'.repeat(200), 'short'], 'ok', 50);
    expect(out).toContain('╭');
    for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    } finally {
      process.stdout.isTTY = tty;
      if (ci !== undefined) process.env.CI = ci;
      if (noColor !== undefined) process.env.NO_COLOR = noColor;
      if (term !== undefined) process.env.TERM = term;
    }
  });

  it('status lines are cut to the window width', () => {
    expect(visibleWidth(fitLine('a'.repeat(300), 40))).toBeLessThanOrEqual(39);
    expect(fitLine('short', 40)).toBe('short');
  });

  it('error cards keep the fix line', () => {
    setPlain(true);
    expect(errorCard('Upload failed\n  Fix: magicpixel login')).toContain('Fix: magicpixel login');
  });

  it('progress bar shows count and percent', () => {
    setPlain(true);
    expect(progressBar(1204, 3114)).toContain('1,204/3,114 · 39%');
  });

  it('long error text wraps inside the card instead of being cut', () => {
    const parts = wrapLine('run magicpixel login with a fresh key from https://magicpixel.art/settings then retry', 40);
    expect(parts.join(' ')).toContain('https://magicpixel.art/settings');
    for (const p of parts) expect(visibleWidth(p)).toBeLessThanOrEqual(40);
  });

  it('setup steps show their place in the total', () => {
    setPlain(true);
    expect(ui.step(2, 'First sync', 3)).toBe('2/3 · First sync');
  });

  it('fix sentences keep their command', () => {
    setPlain(true);
    expect(ui.fixText('run `magicpixel push` once online')).toContain('magicpixel push');
  });

  it('plain mode never animates or redraws', () => {
    setPlain(true);
    expect(canRedraw({ isTTY: true })).toBe(false);
    expect(spinner('Working').isEnabled).toBe(false);
  });

  it('error style follows the error stream, not normal output', () => {
    const out = process.stdout.isTTY;
    const err = process.stderr.isTTY;
    const ci = process.env.CI;
    delete process.env.CI;
    try {
      process.stdout.isTTY = true;
      process.stderr.isTTY = false; // e.g. `sync 2>errors.log`
      expect(errorCard('Upload failed\n  Fix: magicpixel login')).not.toContain('╭');
      expect(isPlain(process.stderr)).toBe(true);
    } finally {
      process.stdout.isTTY = out;
      process.stderr.isTTY = err;
      if (ci !== undefined) process.env.CI = ci;
    }
  });
});
