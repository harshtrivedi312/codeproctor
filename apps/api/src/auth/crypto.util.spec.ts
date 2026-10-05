import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.util';

describe('Secret encryption (FR-102, NFR-04, FU-BE-29)', () => {
  const key = randomBytes(32);

  it('FR-102: a secret round-trips through AES-256-GCM', () => {
    expect(decryptSecret(encryptSecret('JBSWY3DPEHPK3PXP', key), key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('FR-102: a truncated or extended auth tag is rejected before decryption', () => {
    const [v, iv, tag, ct] = encryptSecret('JBSWY3DPEHPK3PXP', key).split('.');
    const bytes = Buffer.from(tag ?? '', 'base64url');
    expect(bytes).toHaveLength(16);
    for (const bad of [
      bytes.subarray(0, 4),
      bytes.subarray(0, 12),
      Buffer.concat([bytes, bytes]),
    ]) {
      expect(() => decryptSecret([v, iv, bad.toString('base64url'), ct].join('.'), key)).toThrow(
        'Invalid authentication tag',
      );
    }
  });

  it('FR-102: a tampered ciphertext is rejected', () => {
    const [v, iv, tag] = encryptSecret('JBSWY3DPEHPK3PXP', key).split('.');
    const other = encryptSecret('AAAAAAAAAAAAAAAA', key).split('.')[3];
    expect(() => decryptSecret([v, iv, tag, other].join('.'), key)).toThrow();
  });
});
