import { describe, expect, it } from 'vitest';
import {
  newPasswordSchema,
  recoveryCodeSchema,
  safeNextPath,
  setPasswordFormSchema,
  twoFactorCodeSchema,
} from './schemas';

describe('FR-102 two-factor code schema', () => {
  it('accepts a 6-digit code', () => {
    expect(twoFactorCodeSchema.safeParse('123456').success).toBe(true);
  });
  it('accepts a recovery code with dashes, spaces and lower case', () => {
    expect(twoFactorCodeSchema.safeParse('abcd-efgh-2345-6723').success).toBe(true);
    expect(recoveryCodeSchema.parse('abcd efgh 2345 6723')).toBe('ABCDEFGH23456723');
  });
  it('rejects anything else with a fix-it message', () => {
    const r = twoFactorCodeSchema.safeParse('12345');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/6-digit code.*recovery code/);
    expect(twoFactorCodeSchema.safeParse('ABCD-EFGH-1111-6723').success).toBe(false);
  });
});

describe('FR-107 password rules', () => {
  it('accepts a password that meets every listed rule', () => {
    expect(newPasswordSchema.safeParse('Correct-Horse-9').success).toBe(true);
  });
  it('lists which rules are missing', () => {
    const r = newPasswordSchema.safeParse('short');
    expect(r.error?.issues[0]?.message).toContain('at least 12 characters');
    expect(r.error?.issues[0]?.message).toContain('one upper-case letter');
  });
  it('does not allow a password the login form would refuse (MAX_PASSWORD_LENGTH)', () => {
    expect(newPasswordSchema.safeParse('Aa1' + 'x'.repeat(1022)).success).toBe(false);
  });
  it('requires the confirmation to match', () => {
    const r = setPasswordFormSchema.safeParse({
      newPassword: 'Correct-Horse-9',
      confirmPassword: 'Correct-Horse-8',
    });
    expect(r.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });
});

describe('safeNextPath', () => {
  it('keeps same-app admin paths', () => {
    expect(safeNextPath('/admin/questions')).toBe('/admin/questions');
  });
  it('refuses external, protocol-relative and auth-loop targets', () => {
    expect(safeNextPath('https://evil.test')).toBe('/admin');
    expect(safeNextPath('//evil.test')).toBe('/admin');
    expect(safeNextPath('/admin/login')).toBe('/admin');
    expect(safeNextPath(null)).toBe('/admin');
  });
});
