/**
 * One look for every CLI message: icons, colors, cards, progress bars.
 * Plain mode (pipes, CI, NO_COLOR, TERM=dumb, --plain) drops colors, emoji and
 * box drawing so logs stay greppable.
 */
import kleur from 'kleur';
import ora, { type Options as OraOptions, type Ora } from 'ora';

let forcedPlain = false;

/** True when output should be plain ASCII without colors. */
export function isPlain(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (forcedPlain) return true;
  const env = process.env;
  if (env.MAGICPIXEL_PLAIN === '1' || 'NO_COLOR' in env || env.TERM === 'dumb' || env.CI) return true;
  return !stream.isTTY;
}

/** In-place updates (spinners, `\r` status lines) only on a live, non-plain terminal. */
export function canRedraw(stream: { isTTY?: boolean } = process.stdout): boolean {
  return !isPlain(stream);
}

/** Spinner that stays silent in plain mode (no animation, no redraws). */
export function spinner(opts: string | OraOptions): Ora {
  const o = typeof opts === 'string' ? { text: opts } : opts;
  return ora({ spinner: 'dots', ...o, isEnabled: canRedraw() && o.isEnabled !== false });
}

/** `--plain` flag: force plain output for this run. */
export function setPlain(on: boolean): void {
  forcedPlain = on;
  if (on) kleur.enabled = false;
}

const EMOJI = {
  ok: '✅', warn: '⚠️ ', fail: '❌', tip: '💡', work: '⏳', watch: '👀', down: '⬇️ ', up: '⬆️ ',
  removed: '🗑 ', sparkle: '✨', ghost: '👻', time: '⏱ ', paused: '⏸ ',
} as const;
const ASCII: Record<keyof typeof EMOJI, string> = {
  ok: '[ok]', warn: '[!]', fail: '[x]', tip: '[>]', work: '[..]', watch: '[watch]', down: '[v]', up: '[^]',
  removed: '[-]', sparkle: '[*]', ghost: '[dry]', time: '[t]', paused: '[||]',
};
export type IconName = keyof typeof EMOJI;

export function icon(name: IconName): string {
  return isPlain() ? ASCII[name] : EMOJI[name];
}

/** One status line: icon + colored text. */
export const ui = {
  ok: (text: string) => `${icon('ok')} ${kleur.green(text)}`,
  warn: (text: string) => `${icon('warn')} ${kleur.yellow(text)}`,
  fail: (text: string) => `${icon('fail')} ${kleur.red(text)}`,
  /** `💡 Fix: <command>` — the command is highlighted so it's easy to copy. */
  fix: (command: string, indent = '   ') => `${indent}${icon('tip')} Fix: ${kleur.cyan().bold(command)}`,
  /** Numbered section header, e.g. `1/4 · Checking your login`. */
  step: (n: number, title: string, total?: number) =>
    `${kleur.magenta().bold(total ? `${n}/${total}` : `Step ${n}`)} ${kleur.dim('·')} ${kleur.bold(title)}`,
  /** `💡 Fix: …` for a sentence that already contains its command in backticks. */
  fixText: (text: string, indent = '   ') =>
    `${indent}${icon('tip')} ${kleur.cyan('Fix:')} ${text.replace(/`([^`]+)`/g, (_, c: string) => kleur.cyan().bold(c))}`,
  name: (s: string) => kleur.cyan(s),
  count: (n: number) => kleur.bold(n.toLocaleString('en-US')),
  dryRun: () => `${icon('ghost')} ${kleur.magenta('Preview only — nothing changed.')}`,
};

// Strip ANSI so widths count visible characters.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function visibleWidth(s: string): number {
  // Emoji are double width in most terminals; variation selectors take none.
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    w += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) || cp === 0x23f1 || cp === 0x23f8 || cp === 0x23f3 ? 2 : 1;
  }
  return w;
}

/** Cut a plain line to `max` visible columns. */
/**
 * Path that fits in `max` columns, keeping the end (the file and its parent
 * folders) and dropping leading folders: `…/rabbit/agni/ear_left_front.png`.
 */
export function shortenPath(path: string, max: number): string {
  const p = path.replace(/\.png$/i, '');
  const limit = Math.max(12, max);
  if (p.length <= limit) return p;
  const parts = p.split('/');
  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > limit) break;
    out = next;
  }
  return out.length + 2 <= limit ? `…/${out}` : `…${out.slice(-(limit - 1))}`;
}

export function fitLine(line: string, columns: number | undefined): string {
  const max = Math.max(20, (columns ?? 80) - 1);
  if (visibleWidth(line) <= max) return line;
  const plain = line.replace(ANSI, '');
  let out = '';
  for (const ch of plain) {
    if (visibleWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Boxed summary. Plain mode prints a title line plus indented rows. */
/** Break a line into pieces no wider than `max` visible columns (at spaces when possible). */
export function wrapLine(line: string, max: number): string[] {
  if (visibleWidth(line) <= max) return [line];
  const plain = line.replace(ANSI, '');
  const out: string[] = [];
  let cur = '';
  for (const word of plain.split(/(\s+)/)) {
    if (visibleWidth(cur + word) <= max) { cur += word; continue; }
    if (cur.trim()) out.push(cur.trimEnd());
    cur = word.trimStart();
    while (visibleWidth(cur) > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function card(
  title: string,
  rows: string[],
  tone: 'ok' | 'warn' | 'fail' | 'info' = 'info',
  columns = process.stdout.columns,
  overflow: 'cut' | 'wrap' = 'cut',
): string {
  const paint = tone === 'ok' ? kleur.green : tone === 'warn' ? kleur.yellow : tone === 'fail' ? kleur.red : kleur.cyan;
  if (isPlain()) return [title, ...rows.map((r) => `  ${r}`)].join('\n');
  const limit = Math.max(30, Math.min(72, (columns ?? 80) - 2));
  const body = rows.flatMap((r) => (visibleWidth(r) <= limit - 6 ? [r] : overflow === 'wrap' ? wrapLine(r, limit - 6) : [fitLine(r, limit - 5)]));
  const inner = Math.min(limit - 2, Math.max(visibleWidth(title) + 4, ...body.map((r) => visibleWidth(r) + 4)));
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`;
  const mid = body.map((r) => `│  ${r}${' '.repeat(Math.max(0, inner - visibleWidth(r) - 2))}│`);
  const bottom = `╰${'─'.repeat(inner)}╯`;
  return [paint(top), ...mid.map((m) => paint('│') + m.slice(1, -1) + paint('│')), paint(bottom)].join('\n');
}

/** `[████░░░░] 1,204 / 3,114 · 39%` */
export function progressBar(done: number, total: number, width = 20): string {
  const pct = total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
  const filled = Math.round((pct / 100) * width);
  const [on, off] = isPlain() ? ['#', '.'] : ['█', '░'];
  return `[${kleur.green(on.repeat(filled))}${kleur.dim(off.repeat(width - filled))}] ${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')} · ${pct}%`;
}

/** Format a multi-line error (first line = what happened, `Fix:` lines = how to fix). */
export function errorCard(message: string): string {
  const lines = message.split('\n').map((l) => l.trimEnd()).filter((l, i) => i === 0 || l.trim().length > 0);
  const [head, ...rest] = lines;
  const rows = rest.map((l) => {
    const t = l.trim();
    if (/^fix:/i.test(t)) return `${icon('tip')} ${kleur.cyan(t)}`;
    if (/request id/i.test(t)) return kleur.dim(t);
    return t;
  });
  if (isPlain(process.stderr)) return [`${icon('fail')} ${head}`, ...rows.map((r) => `  ${r}`)].join('\n');
  const cols = process.stderr.columns ?? process.stdout.columns ?? 80;
  const text = head ?? 'Something went wrong';
  const fits = visibleWidth(text) <= Math.min(72, cols - 2) - 8;
  const title = `${icon('fail')} ${fits ? kleur.bold(text) : 'Something went wrong'}`;
  return card(title, fits ? (rows.length ? rows : [kleur.dim('Run the command again, or add --plain for a log-friendly copy.')]) : [kleur.bold(text), ...rows], 'fail', cols, 'wrap');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
