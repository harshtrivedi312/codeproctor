import { z } from 'zod';

/** RFC 5321 path limit for an email address. */
export const MAX_EMAIL_LENGTH = 254;
/**
 * Upper bound on a password in any request body. Bounds the Argon2id work an anonymous caller can
 * trigger (FR-101, NFR-04). The FR-107 reset schema must not allow a longer password than this.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/** FR-101: staff login form payload. Password strength rules live in the reset schema (FR-107). */
export const loginRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .max(MAX_EMAIL_LENGTH, 'Enter a valid email address.')
    .email('Enter a valid email address.'),
  password: z
    .string()
    .min(1, 'Enter your password.')
    .max(MAX_PASSWORD_LENGTH, 'Password is too long.'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Six-digit one-time code: TOTP (FR-102) or the candidate email OTP (FR-401). */
export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code.');

/**
 * The signed-in staff user returned with every authenticated session (login, 2FA verify, enrolment
 * confirm, refresh). `totpEnabled` is the caller's own current 2FA state, read-only, server-set
 * (FR-102); it never appears on pre-2FA, challenge or other-user responses.
 */
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER']),
  orgName: z.string(),
  totpEnabled: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;
