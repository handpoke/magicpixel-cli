import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export interface FileHash {
  sha256: string;
  mtimeMs: number;
  size: number;
}

/** Process-lifetime cache: skip re-reading a PNG when mtime+size are unchanged. */
const cache = new Map<string, FileHash>();

export function clearFileHashCache(): void {
  cache.clear();
}

export async function hashFile(
  path: string,
  hint?: Pick<FileHash, 'sha256' | 'mtimeMs' | 'size'>,
): Promise<FileHash | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    cache.delete(path);
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    cache.delete(path);
    return null;
  }
  if (hint && hint.mtimeMs === st.mtimeMs && hint.size === st.size) {
    const rec: FileHash = { sha256: hint.sha256, mtimeMs: st.mtimeMs, size: st.size };
    cache.set(path, rec);
    return rec;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const buf = await readFile(path);
  const rec: FileHash = {
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
  cache.set(path, rec);
  return rec;
}

export async function fileSha256(path: string): Promise<string | null> {
  const hashed = await hashFile(path);
  return hashed?.sha256 ?? null;
}
