import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function fileSha256(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}
