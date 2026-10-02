import { loginRequestSchema, otpCodeSchema, runRequestSchema } from '@codeproctor/shared';
import { describe, expect, it } from 'vitest';

describe('shared zod schemas used by react-hook-form', () => {
  it('FR-101: login rejects an invalid email with a fix-it message', () => {
    const r = loginRequestSchema.safeParse({ email: 'nope', password: 'x' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Enter a valid email address.');
  });
  it('accepts a six digit code only', () => {
    expect(otpCodeSchema.safeParse('123456').success).toBe(true);
    expect(otpCodeSchema.safeParse('12345').success).toBe(false);
  });
  it('FR-101: login rejects an oversized password so Argon2id work stays bounded', () => {
    const r = loginRequestSchema.safeParse({ email: 'a@example.com', password: 'x'.repeat(1025) });
    expect(r.success).toBe(false);
  });
  it('FR-502: run request rejects source code over 100000 characters', () => {
    expect(
      runRequestSchema.safeParse({ language: 'python', code: 'x'.repeat(100_000) }).success,
    ).toBe(true);
    expect(
      runRequestSchema.safeParse({ language: 'python', code: 'x'.repeat(100_001) }).success,
    ).toBe(false);
  });
});
