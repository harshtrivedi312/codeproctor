// demo-totp.mjs against the RFC 6238 test vectors (SHA-1, secret "12345678901234567890").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { base32Decode, totp } from './demo-totp.mjs';

const SECRET = Buffer.from('12345678901234567890');
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('demo-totp (local demo helper)', () => {
  it('RFC 6238 appendix B vectors (8 digits) match', () => {
    const vectors = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [seconds, expected] of vectors)
      assert.equal(totp(SECRET, seconds * 1000, { digits: 8 }), expected, String(seconds));
  });

  it('decodes base32 with spaces, dashes, lower case and padding', () => {
    assert.deepEqual(base32Decode(SECRET_B32), SECRET);
    assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=='), SECRET);
  });

  it('refuses a key that is not base32 or is empty', () => {
    assert.throws(() => base32Decode('not base32 !'), /not base32/);
    assert.throws(() => base32Decode('   '), /empty/);
  });

  it('the command prints a 6 digit code and how long it is valid, and refuses no argument', () => {
    const ok = spawnSync('node', ['infra/scripts/demo-totp.mjs', SECRET_B32], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^\d{6} {2}\(valid for about \d+ seconds\)\n$/);
    const none = spawnSync('node', ['infra/scripts/demo-totp.mjs'], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /usage/);
    const bad = spawnSync('node', ['infra/scripts/demo-totp.mjs', '1189!'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not base32/);
  });
});
