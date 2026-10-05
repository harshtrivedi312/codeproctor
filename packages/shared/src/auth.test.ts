import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_EMAIL_LENGTH, sessionUserSchema } from './auth';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.com',
  name: 'A',
  role: 'RECRUITER',
  orgName: 'Acme',
  totpEnabled: false,
};

void describe('sessionUserSchema (FR-102)', () => {
  void it('FR-102: accepts a session user that carries totpEnabled', () => {
    assert.equal(sessionUserSchema.parse(user).totpEnabled, false);
  });
  void it('FR-102: rejects a non-uuid id and an over-long name', () => {
    assert.equal(sessionUserSchema.safeParse({ ...user, id: 'u1' }).success, false);
    assert.equal(sessionUserSchema.safeParse({ ...user, name: 'x'.repeat(201) }).success, false);
  });
  void it('FR-102: email is bounded at MAX_EMAIL_LENGTH (254 ok, 255 rejected)', () => {
    const email = (n: number): string => `${'a'.repeat(n - 4)}@b.c`;
    assert.equal(
      sessionUserSchema.safeParse({ ...user, email: email(MAX_EMAIL_LENGTH) }).success,
      true,
    );
    assert.equal(sessionUserSchema.safeParse({ ...user, email: email(255) }).success, false);
  });
  void it('FR-102: rejects an over-long orgName', () => {
    assert.equal(sessionUserSchema.safeParse({ ...user, orgName: 'x'.repeat(201) }).success, false);
  });
  void it('FR-102: rejects a session user without a boolean totpEnabled', () => {
    const rest: Partial<typeof user> = { ...user };
    delete rest.totpEnabled;
    assert.equal(sessionUserSchema.safeParse(rest).success, false);
    assert.equal(sessionUserSchema.safeParse({ ...user, totpEnabled: 'yes' }).success, false);
  });
});
