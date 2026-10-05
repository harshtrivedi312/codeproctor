import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authUserSchema } from './auth';

const user = {
  id: 'u1',
  email: 'a@example.com',
  name: 'A',
  role: 'RECRUITER',
  orgName: 'Acme',
  totpEnabled: false,
};

void describe('authUserSchema (FR-102)', () => {
  void it('FR-102: accepts a session user that carries totpEnabled', () => {
    assert.equal(authUserSchema.parse(user).totpEnabled, false);
  });
  void it('FR-102: rejects a session user without a boolean totpEnabled', () => {
    const rest: Partial<typeof user> = { ...user };
    delete rest.totpEnabled;
    assert.equal(authUserSchema.safeParse(rest).success, false);
    assert.equal(authUserSchema.safeParse({ ...user, totpEnabled: 'yes' }).success, false);
  });
});
