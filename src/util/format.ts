/**
 * Human-readable byte formatter shared by `sync` (download summary, progress
 * bar) and `list` (manifest table). Single source of truth — keep new
 * call sites pointed here rather than re-implementing locally.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
