import { Injectable, OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

// Argon2id (algorithm 2), OWASP-recommended parameters (FR-101, NFR-04).
export const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  // A real hash of a random value, so an unknown email costs the same as a wrong password.
  // Computed at startup so no request pays for it (FU-BE-30).
  private dummy?: Promise<string>;

  async onModuleInit(): Promise<void> {
    await this.dummyHash();
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= this.hash(`dummy-${randomBytes(16).toString('hex')}`);
    return this.dummy;
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  async burn(password: string): Promise<void> {
    await this.verify(await this.dummyHash(), password);
  }
}
