import { MAX_PASSWORD_LENGTH, otpCodeSchema, type UserRole } from '@codeproctor/shared';
import { z } from 'zod';

/*
 * Web-local schemas for the Security page (FR-102, FU-BE-39). Setting up, disabling and
 * regenerating recovery codes all re-ask the current password and send it as `currentPassword` in
 * the body. [ARC-02] These belong in packages/shared; see docs/followups/frontend.md.
 */

export const currentPasswordSchema = z
  .string()
  .min(1, 'Enter your current password.')
  .max(MAX_PASSWORD_LENGTH, 'Enter your current password.');

/** Body of 2FA setup start, disable and recovery-code regeneration. */
export const reauthBodySchema = z.object({ currentPassword: currentPasswordSchema });
/** Body of 2FA setup confirm. */
export const setupConfirmBodySchema = reauthBodySchema.extend({ code: otpCodeSchema });

export const passwordFormSchema = reauthBodySchema;
export type PasswordFormValues = z.infer<typeof passwordFormSchema>;
export const codeFormSchema = z.object({ code: otpCodeSchema });
export type CodeFormValues = z.infer<typeof codeFormSchema>;

/** The 403 error code the API sends for a wrong current password. */
export const REAUTH_FAILED_CODE = 'REAUTH_FAILED';
/** The only text shown for it, inside the dialog. */
export const REAUTH_FAILED_MESSAGE = 'Password incorrect';

/** FR-102: 2FA is mandatory for these roles, so it cannot be turned off. [ARC-02] shared constant. */
export const TWO_FACTOR_MANDATORY_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'REVIEWER'];
export function isTwoFactorMandatory(role: UserRole | null | undefined): boolean {
  return role !== null && role !== undefined && TWO_FACTOR_MANDATORY_ROLES.includes(role);
}
