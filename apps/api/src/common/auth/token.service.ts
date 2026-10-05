// HS256 JWTs for staff (FR-104). One secret, one algorithm: verification pins HS256 so a token
// cannot pick its own algorithm. Never log a token.
import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { Env } from '../../config/env';
import { TokenValidityService } from './token-validity.service';

@Injectable()
export class TokenService {
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  sign(claims: Record<string, string>, ttlSeconds: number): string {
    return jwt.sign(claims, this.secret, { algorithm: 'HS256', expiresIn: ttlSeconds });
  }

  /** Returns the payload, or throws when the signature, algorithm or expiry is wrong. */
  verify(token: string): unknown {
    return jwt.verify(token, this.secret, { algorithms: ['HS256'] });
  }
}

@Global()
@Module({
  providers: [TokenService, TokenValidityService],
  exports: [TokenService, TokenValidityService],
})
export class TokenModule {}
