/**
 * Small picomatch subset (`*`, `**`, `?`) so `connect` globs work without
 * adding a runtime dependency. Case-insensitive; backslashes treated as `/`.
 */
const regexCache = new Map<string, RegExp>();

export function matchGlob(path: string, pattern: string): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const g = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g) return false;
  let re = regexCache.get(g);
  if (!re) {
    re = globToRegExp(g);
    regexCache.set(g, re);
  }
  return re.test(p);
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (c === '*') {
      out += '[^/]*';
      i += 1;
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else {
      if (/[.+^${}()|[\]\\]/.test(c)) out += `\\${c}`;
      else out += c;
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}
