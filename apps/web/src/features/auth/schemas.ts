import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, otpCodeSchema } from '@codeproctor/shared';
import { z } from 'zod';

/*
 * Web-local schemas for FR-101, FR-102 and FR-107. They reuse the shared constants and schemas and
 * only add what packages/shared does not have yet; the needed shared additions are listed as
 * [ARC-02] in docs/followups/frontend.md.
 */

/** ADR 0003 section 1: 16 random base32 characters. Shown as groups of 4; spaces and dashes are ignored. */
export const RECOVERY_CODE_LENGTH = 16;
const RECOVERY_CODE_PATTERN = /^[A-Z2-7]{16}$/;

export function normalizeRecoveryCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export const recoveryCodeSchema = z
  .string()
  .transform(normalizeRecoveryCode)
  .pipe(z.string().regex(RECOVERY_CODE_PATTERN, 'Enter the 16-character recovery code.'));

/** FR-102: the verify step takes a 6-digit authenticator code or a recovery code. */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .min(1, 'Enter the 6-digit code from your authenticator app, or a recovery code.')
  .superRefine((value, ctx) => {
    const isOtp = otpCodeSchema.safeParse(value).success;
    const isRecovery = recoveryCodeSchema.safeParse(value).success;
    if (!isOtp && !isRecovery) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Enter the 6-digit code from your authenticator app, or a 16-character recovery code.',
      });
    }
  });

/** FR-107: forgot password only needs an email. The page answers the same whatever it is. */
export const forgotPasswordFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .max(MAX_EMAIL_LENGTH, 'Enter a valid email address.')
    .email('Enter a valid email address.'),
});

export const MIN_PASSWORD_LENGTH = 12;

/** Strength rules shown next to the field (FR-107). The same list drives the checklist and the schema. */
export const PASSWORD_RULES: readonly {
  id: string;
  label: string;
  test: (v: string) => boolean;
}[] = [
  {
    id: 'length',
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    test: (v) => v.length >= MIN_PASSWORD_LENGTH,
  },
  { id: 'lower', label: 'One lower-case letter', test: (v) => /[a-z]/.test(v) },
  { id: 'upper', label: 'One upper-case letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'digit', label: 'One number', test: (v) => /\d/.test(v) },
];

export const newPasswordSchema = z
  .string()
  .max(MAX_PASSWORD_LENGTH, 'Password is too long.')
  .superRefine((value, ctx) => {
    const failed = PASSWORD_RULES.filter((rule) => !rule.test(value));
    if (failed.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Choose a stronger password: ${failed.map((r) => r.label.toLowerCase()).join(', ')}.`,
      });
    }
  });

export const setPasswordFormSchema = z
  .object({ newPassword: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match. Type the same password in both fields.',
  });
export type SetPasswordForm = z.infer<typeof setPasswordFormSchema>;

/** Only same-app /admin paths are allowed as a post-login target (no open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/admin') || next.startsWith('//') || next.includes('\\')) {
    return '/admin';
  }
  if (/^\/admin\/(login|2fa|forgot-password|reset-password)/.test(next)) return '/admin';
  return next;
}
