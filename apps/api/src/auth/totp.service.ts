// TOTP 2FA with otplib (FR-102): secrets are AES-256-GCM encrypted at rest.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Env } from '../config/env';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { decryptSecret, encryptSecret } from './crypto.util';

const STEP_SECONDS = 30;
// Covers the matched step plus one step of drift on each side.
const USED_TTL_SECONDS = 120;

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
   * recorded with an atomic Redis SET NX, so a replay inside the window is refused. If Redis is
   * unavailable the code is refused (fail closed).
   */
  async verify(userId: string, encryptedSecret: string, code: string): Promise<boolean> {
    let step: number;
    try {
      // One 30-second step of drift either way.
      const delta = authenticator
        .clone({ window: 1 })
        .checkDelta(code, decryptSecret(encryptedSecret, this.key));
      if (delta === null) return false;
      step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + delta;
    } catch {
      return false;
    }
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      const claimed = await this.redis.set(
        `auth:totp:used:${userId}:${step}`,
        '1',
        'EX',
        USED_TTL_SECONDS,
        'NX',
      );
      return claimed === 'OK';
    } catch {
      return false;
    }
  }
}
