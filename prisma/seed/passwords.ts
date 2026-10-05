// argon2id hashing for the seeded staff accounts (DB-04, Q-28). @node-rs/argon2 is a dependency of
// apps/api (BE-02 reuses it for staff auth), not of the repository root, so it is resolved from
// there, the same way infra/scripts/set-app-user-password.mjs loads `pg` (FU-DB-18).
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

interface Argon2Options {
  readonly algorithm?: number;
  readonly memoryCost?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
}
interface Argon2Module {
  hash(password: string, options?: Argon2Options): Promise<string>;
}

// Argon2id is value 2 of the library's Algorithm enum (it is a const enum, so not importable).
const ARGON2ID = 2;
// OWASP's minimum for argon2id: 19 MiB of memory, 2 passes, 1 lane. BE-02 may choose its own.
const OPTIONS: Argon2Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export type PasswordHasher = (plain: string) => Promise<string>;

export function loadPasswordHasher(repoRoot: string): PasswordHasher {
  const requireFromApi = createRequire(resolve(repoRoot, 'apps/api/package.json'));
  const argon2 = requireFromApi('@node-rs/argon2') as Argon2Module;
  return async (plain) => {
    const hash = await argon2.hash(plain, OPTIONS);
    if (!hash.startsWith('$argon2id$')) throw new Error('The password hash is not argon2id.');
    return hash;
  };
}
