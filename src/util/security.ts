import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

/** Max PNG payload per asset (64 MiB). */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Resolved path must stay under `rootDir` (prevents manifest-driven path traversal).
 */
export function assertPathInsideRoot(targetPath: string, rootDir: string, label: string): void {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(
    `refusing to write outside ${label} (${relative(process.cwd(), root) || '.'}).\n` +
      `  Fix: report unexpected folder/slug values to MagicPixel support.`,
  );
}

/**
 * Reject manifest folder/slug values that could escape via `..` or separators.
 */
export function assertSafeAssetSegments(folder: string | null, slug: string, key: string): void {
  const badSegment = (seg: string) =>
    seg.length === 0 || seg === '.' || seg === '..' || /[\0\\]/.test(seg);
  if (badSegment(slug)) {
    throw new Error(`unsafe asset slug in manifest for key "${key}".`);
  }
  if (folder !== null) {
    for (const seg of folder.split('/')) {
      if (badSegment(seg)) {
        throw new Error(`unsafe asset folder in manifest for key "${key}".`);
      }
    }
  }
}

/**
 * Custom endpoints must be HTTPS (unless MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1 for local http).
 * Credentials embedded in the URL are rejected.
 */
export function validateEndpointUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `endpoint is not a valid URL: ${raw}\n` +
        `  Fix: use https://… or remove "endpoint" from magicpixel.json.`,
    );
  }
  // Explicit allowlist of schemes. Anything outside { https, http } —
  // file:, data:, javascript:, ws:, gopher:, etc. — is rejected up-front
  // with a clearer message than the generic HTTPS error.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `endpoint scheme "${url.protocol}" is not allowed.\n` +
        `  Fix: use an https:// URL (http://localhost is allowed with MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1).`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `endpoint must not embed credentials in the URL.\n` +
        `  Fix: use MAGICPIXEL_API_KEY for auth, not user:pass@host.`,
    );
  }
  if (url.protocol === 'https:') {
    return normalizeEndpointBase(url);
  }
  const allowInsecure = process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT === '1';
  if (allowInsecure && url.hostname === 'localhost') {
    return normalizeEndpointBase(url);
  }
  if (allowInsecure && url.hostname === '127.0.0.1') {
    return normalizeEndpointBase(url);
  }
  throw new Error(
    `endpoint must use HTTPS (${url.protocol}//${url.host}).\n` +
      `  Fix: remove "endpoint" to use production, or for local http://localhost set ` +
      `MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1.`,
  );
}

function normalizeEndpointBase(url: URL): string {
  // Drop query/hash; trim trailing slash on pathname (except root).
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `${url.protocol}//${url.host}${path}`;
}

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}

export function etagForSha256(sha256: string): string {
  if (!isSha256Hex(sha256)) {
    throw new Error('internal: refusing to send If-None-Match for non-sha256 value');
  }
  return `"${sha256.toLowerCase()}"`;
}

export function tmpPathFor(diskPath: string): string {
  const suffix = randomBytes(8).toString('hex');
  return `${diskPath}.${process.pid}.${suffix}.tmp`;
}

/**
 * Follow redirects only within the same origin as the initial request (prevents API key leak).
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (!location) {
      throw new Error(`HTTP ${res.status} redirect without Location header.`);
    }
    const next = new URL(location, current);
    if (next.origin !== origin) {
      throw new Error(
        `refusing cross-origin redirect to ${next.origin}.\n` +
          `  Fix: point "endpoint" directly at the integration API; do not use redirecting URLs.`,
      );
    }
    current = next.href;
  }
  throw new Error('too many HTTP redirects (max 5).');
}

export async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      await res.body?.cancel();
      throw new Error(`response too large (${n} bytes, max ${maxBytes}).`);
    }
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`response too large (${buf.byteLength} bytes, max ${maxBytes}).`);
  }
  return buf;
}

/** Max length of a user-supplied picomatch glob; shared with config.ts. */
export const MAX_GLOB_LEN = 256;

/** Validate a user-supplied picomatch glob from the CLI. */
export function assertSafeGlob(glob: string): string {
  const g = glob.trim();
  if (!g || g.length > MAX_GLOB_LEN || g.includes('\0')) {
    throw new Error(`invalid glob pattern (empty, too long, or contains null bytes).`);
  }
  return g;
}

/**
 * Trim + validate a candidate `outDir`. Single source of truth shared by
 * `init` (prompt-time) and `loadConfig` (file-time) so a path that survives
 * one is guaranteed to survive the other.
 *
 * Returns the trimmed value. Throws on:
 *   - empty / whitespace-only input
 *   - any `..` segment or null byte
 *   - absolute paths — otherwise an outDir like `/tmp/mp` would resolve to
 *     itself and bypass the cwd-relative containment check in
 *     `assertPathInsideRoot`, letting a manifest write outside the project
 *     tree. `outDir` must always be relative to the project root.
 */
export function assertSafeOutDir(value: string): string {
  const v = value.trim();
  if (!v) {
    throw new Error('outDir must not be empty.');
  }
  if (v.includes('\0') || v.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new Error('outDir must not contain ".." segments or null bytes.');
  }
  if (isAbsolute(v)) {
    throw new Error('outDir must be a relative path (not absolute).');
  }
  return v;
}
