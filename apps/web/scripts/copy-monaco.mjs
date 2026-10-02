// Self-hosts Monaco: copies the minified AMD build from node_modules into public/monaco so the
// editor never loads from a CDN (CSP script-src stays 'self' + nonce). Output is git-ignored.
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(root, 'public', 'monaco', 'vs');

await rm(dest, { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`monaco: copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
