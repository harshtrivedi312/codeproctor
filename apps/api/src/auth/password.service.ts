import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// Argon2id (algorithm 2), OWASP-recommended parameters (FR-101, NFR-04).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  // A real hash of a random value, so an unknown email costs the same as a wrong password.
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  async burn(password: string): Promise<void> {
    this.dummy ??= this.hash(`dummy-${Math.random()}`);
    await this.verify(await this.dummy, password);
  }
}
