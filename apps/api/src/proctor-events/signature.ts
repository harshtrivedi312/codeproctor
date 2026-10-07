// HMAC-SHA256 checks for signed batches (ADR 0013 section 2). The server verifies the received
// bytes, never a re-serialisation. All comparisons are constant time. Keys and signatures are never
// logged.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** `X-Signature`: lowercase hex HMAC-SHA256, exactly 64 characters. */
export const SIGNATURE_FORMAT = /^[0-9a-f]{64}$/;

export function hmacOf(key: Buffer, raw: Buffer): Buffer {
  return createHmac('sha256', key).update(raw).digest();
}

/** Constant-time equality that is also false (not a throw) for different lengths. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** How many earlier auth epochs still count as "the same device re-signing" (ADR 0013 section 2). */
export const EPOCH_WINDOW = 8;
