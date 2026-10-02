import { z } from 'zod';

/** FR-101: staff login form payload. Password strength rules live in the reset schema (FR-107). */
export const loginRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Six-digit one-time code: TOTP (FR-102) or the candidate email OTP (FR-401). */
export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code.');
