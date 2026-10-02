import { loginRequestSchema, otpCodeSchema } from '@codeproctor/shared';
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
});
