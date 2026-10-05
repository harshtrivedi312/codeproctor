// Small crypto helpers for staff auth. Nothing here logs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Short fingerprint of the current password hash; changes whenever the password does. */
export function passwordVersion(passwordHash: string): string {
  return sha256Hex(passwordHash).slice(0, 16);
}

/** 32 random bytes as base64url: refresh tokens and password-reset tokens. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A recovery code: 16 random base32 characters, 80 bits (ADR 0003 section 1). */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  // 256 is a multiple of 32, so masking the low 5 bits is unbiased.
  return Array.from(bytes, (b) => BASE32[b & 31]).join('');
}

/** Users may type codes in lowercase or with separators. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const GCM_TAG_BYTES = 16;

/** AES-256-GCM, stored as v1.iv.tag.ciphertext (base64url parts). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ct] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  // Pin the tag length: a shortened tag is far easier to forge (FU-BE-29).
  const tagBytes = Buffer.from(tag, 'base64url');
  if (tagBytes.length !== GCM_TAG_BYTES) throw new Error('Invalid authentication tag');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
