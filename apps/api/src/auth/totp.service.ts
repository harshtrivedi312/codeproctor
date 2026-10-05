// TOTP 2FA with otplib (FR-102): secrets are AES-256-GCM encrypted at rest.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Env } from '../config/env';
import { decryptSecret, encryptSecret } from './crypto.util';

@Injectable()
export class TotpService {
  private readonly key: Buffer;
  private readonly issuer: string;

  constructor(config: ConfigService<Env, true>) {
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

  verify(encryptedSecret: string, code: string): boolean {
    try {
      // One 30-second step of drift either way.
      return authenticator
        .clone({ window: 1 })
        .check(code, decryptSecret(encryptedSecret, this.key));
    } catch {
      return false;
    }
  }
}
