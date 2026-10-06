// Minimal ULID (48-bit time, 80-bit randomness, Crockford base32) for object key names (ADR 0013
// section 5.7). Keys carry only UUIDs, ULIDs and fixed words: no names, emails or tokens.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newUlid(now: Date = new Date()): string {
  let time = now.getTime();
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}
