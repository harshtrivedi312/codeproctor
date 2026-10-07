// Prints the current TOTP code for a secret, so the local demo needs no phone (docs/local-run.md).
//
//   node infra/scripts/demo-totp.mjs <manual key from the 2FA enrolment page>
//
// RFC 6238 with the defaults every authenticator app uses: HMAC-SHA1, 6 digits, 30 second steps. The
// manual key is the base32 secret that the enrolment page shows under the QR code (spaces allowed, and
// it can be given as several arguments). It is a development account's secret on a local database:
// never use this with a real account. Pure computation: it reads no .env and opens no connection.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) to bytes. Throws on a character outside the alphabet. */
export function base32Decode(text) {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean === '') throw new Error('the key is empty.');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('the key is not base32 (letters A-Z and digits 2-7).');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for the 30 second step that contains `nowMs`. */
export function totp(secret, nowMs = Date.now(), { digits = 6, stepSeconds = 30 } = {}) {
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = process.argv.slice(2).join(' ');
  if (key.trim() === '') {
    console.error('demo-totp: usage: node infra/scripts/demo-totp.mjs <manual key>');
    process.exit(1);
  }
  try {
    const nowMs = Date.now();
    const code = totp(base32Decode(key), nowMs);
    const left = 30 - (Math.floor(nowMs / 1000) % 30);
    console.log(`${code}  (valid for about ${left} seconds)`);
  } catch (error) {
    console.error(`demo-totp: ${error instanceof Error ? error.message : 'failed.'}`);
    process.exit(1);
  }
}
