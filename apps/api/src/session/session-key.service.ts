// Per-session HMAC key lifecycle (ADR 0013 section 2). One 32-byte master key M per session is
// created at VERIFIED to IN_PROGRESS and stored wrapped with AES-256-GCM in sessions.hmac_key_enc:
//   v1:<kid>:<b64 nonce>:<b64 ciphertext+tag>, AAD = the session id (a ciphertext copied to another
//   row does not decrypt). `kid` names the wrapping key SESSION_KEY_ENC_KEY_<kid> (32 bytes, base64)
//   so the env key can rotate without a migration.
// The browser never receives M. It receives K_e = HMAC-SHA256(M, "codeproctor:batch-key:v1:" +
// sessionId + ":" + epoch) for its current auth epoch, once (see proctor-key in the candidate module).
// Never log M, K_e, the wrapped value or the wrapping keys.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Env } from '../config/env';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KID = /^[A-Za-z0-9]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SessionKeyConfigError extends Error {}

function canonicalSessionId(sessionId: string): string {
  const id = sessionId.toLowerCase();
  if (!UUID.test(id)) throw new Error('A session key needs a canonical session UUID');
  return id;
}

@Injectable()
export class SessionKeyService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private wrappingKey(kid: string): Buffer {
    if (!KID.test(kid)) throw new SessionKeyConfigError('Invalid key id');
    // Read at use, not at start: the staff-only suites and local tooling run without it.
    const raw = process.env[`SESSION_KEY_ENC_KEY_${kid}`];
    if (raw === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
      throw new SessionKeyConfigError(`SESSION_KEY_ENC_KEY_${kid} is missing or malformed`);
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SessionKeyConfigError(`SESSION_KEY_ENC_KEY_${kid} must be 32 bytes, base64`);
    }
    return key;
  }

  /** A new 32-byte master key, wrapped for storage. The plain key is not returned. */
  generateWrapped(sessionId: string): string {
    const id = canonicalSessionId(sessionId);
    const kid = this.config.get('SESSION_KEY_ENC_ACTIVE_KID', { infer: true });
    const master = randomBytes(KEY_BYTES);
    try {
      return this.wrap(master, id, kid);
    } finally {
      master.fill(0);
    }
  }

  wrap(master: Buffer, sessionId: string, kid: string): string {
    const id = canonicalSessionId(sessionId);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.wrappingKey(kid), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const body = Buffer.concat([cipher.update(master), cipher.final(), cipher.getAuthTag()]);
    return `v1:${kid}:${nonce.toString('base64')}:${body.toString('base64')}`;
  }

  /** Throws when the value is malformed, belongs to another session, or was tampered with. */
  unwrap(stored: string, sessionId: string): Buffer {
    const id = canonicalSessionId(sessionId);
    const parts = stored.split(':');
    const [version, kid, nonceB64, bodyB64] = parts;
    if (parts.length !== 4 || version !== 'v1' || !kid || !nonceB64 || !bodyB64) {
      throw new Error('Unsupported wrapped key format');
    }
    const nonce = Buffer.from(nonceB64, 'base64');
    const body = Buffer.from(bodyB64, 'base64');
    if (nonce.length !== NONCE_BYTES || body.length !== KEY_BYTES + TAG_BYTES) {
      throw new Error('Unsupported wrapped key format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.wrappingKey(kid), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(id, 'utf8'));
    decipher.setAuthTag(body.subarray(KEY_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, KEY_BYTES)), decipher.final()]);
  }

  /** K_e for one auth epoch (ADR 0013 section 2). BE-10 verifies batches with the same function. */
  deriveBatchKey(master: Buffer, sessionId: string, epoch: number): Buffer {
    if (!Number.isInteger(epoch) || epoch < 0) throw new Error('Invalid epoch');
    const id = canonicalSessionId(sessionId);
    return createHmac('sha256', master)
      .update(`codeproctor:batch-key:v1:${id}:${String(epoch)}`, 'utf8')
      .digest();
  }

  /** Unwrap and derive in one step; the master key is not kept. */
  batchKeyFor(stored: string, sessionId: string, epoch: number): Buffer {
    const master = this.unwrap(stored, sessionId);
    try {
      return this.deriveBatchKey(master, sessionId, epoch);
    } finally {
      master.fill(0);
    }
  }
}
