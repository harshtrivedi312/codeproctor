// TOTP 2FA with otplib (FR-102): secrets are AES-256-GCM encrypted at rest.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Env } from '../config/env';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { decryptSecret, encryptSecret } from './crypto.util';

const STEP_SECONDS = 30;
// Covers the matched step plus one step of drift on each side.
const USED_TTL_SECONDS = 120;
// Deletes the used-step key only while it still holds this request's marker (FU-BE-208).
const RELEASE_IF_OWNED =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/**
 * Filled by verify() when this request recorded a used step. Its release() gives that one key back
 * (DEL of the exact key, only while it still holds this request's marker), so a caller whose
 * database work rolled back CLEANLY can let an honest retry reuse the code (FU-BE-208, DL-37).
 * Absent after a wrong, replayed or unverifiable code: nothing was recorded, nothing to release.
 * release() never throws; a failed release leaves the mark until its TTL (the retry waits).
 */
export interface TotpMarkHandle {
  release?: () => Promise<void>;
}

@Injectable()
export class TotpService {
  private readonly key: Buffer;
  private readonly issuer: string;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const encoded: string = config.get('ENCRYPTION_KEY', { infer: true });
    this.key = Buffer.from(encoded, 'base64');
    this.issuer = config.get('TOTP_ISSUER', { infer: true });
  }

  async createEnrollment(
    email: string,
  ): Promise<{ secret: string; encrypted: string; otpauthUrl: string; qrDataUrl: string }> {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(email, this.issuer, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { secret, encrypted: encryptSecret(secret, this.key), otpauthUrl, qrDataUrl };
  }

  /**
   * Checks a code and accepts each time step once per user (FU-BE-20). The step that matched is
   * recorded with an atomic Redis SET NX, so a replay inside the window is refused. Returns false
   * for a wrong or replayed code. When Redis is unavailable the code is refused by throwing a 503
   * (fail closed), which callers must not count as a failed guess. When `mark` is given and the
   * step was recorded by this call, `mark.release` is set (see TotpMarkHandle).
   */
  async verify(
    userId: string,
    encryptedSecret: string,
    code: string,
    mark?: TotpMarkHandle,
  ): Promise<boolean> {
    let step: number;
    try {
      // Read the clock once: the step recorded must be the one the code was checked against, even
      // if a step boundary passes while this runs (FU-BE-20). One step of drift either way.
      const epoch = Date.now();
      const delta = authenticator
        .clone({ window: 1, epoch })
        .checkDelta(code, decryptSecret(encryptedSecret, this.key));
      if (delta === null) return false;
      step = Math.floor(epoch / 1000 / STEP_SECONDS) + delta;
    } catch {
      return false;
    }
    try {
      // A command that timed out but was applied makes the retry look like a replay: it is refused
      // (fails closed), and the user waits for the next code.
      await ensureConnected(this.redis);
      const key = `auth:totp:used:${userId}:${step}`;
      const marker = randomUUID();
      const claimed = await this.redis.set(key, marker, 'EX', USED_TTL_SECONDS, 'NX');
      if (claimed !== 'OK') return false;
      if (mark) {
        mark.release = async (): Promise<void> => {
          try {
            await this.redis.eval(RELEASE_IF_OWNED, 1, key, marker);
          } catch {
            // The mark stays until its TTL: the retry waits for the next code (fails closed).
          }
        };
      }
      return true;
    } catch {
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
  }
}
