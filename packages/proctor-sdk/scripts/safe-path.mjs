import { resolve, sep } from 'node:path';

/**
 * Destination for a file name taken from a remote manifest. Accepts only plain file names
 * (letters, digits, `_`, `.`, `-`, no separators) and double-checks that the resolved path stays
 * inside `dir`. Throws otherwise (path traversal).
 */
export function safeChildPath(dir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || /^\.+$/.test(name)) {
    throw new Error(`Refusing unsafe manifest path: ${JSON.stringify(name)}`);
  }
  const base = resolve(dir);
  const dest = resolve(base, name);
  if (!dest.startsWith(base + sep)) {
    throw new Error(`Refusing manifest path outside ${base}: ${JSON.stringify(name)}`);
  }
  return dest;
}
