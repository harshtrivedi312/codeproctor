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

/** Disable also needs a 6-digit TOTP code (never a recovery code); whitespace is trimmed. Backend PR #51. */
export const TOTP_CODE_MESSAGE = 'Enter the 6-digit code from your authenticator app';
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, TOTP_CODE_MESSAGE);
export const disableBodySchema = reauthBodySchema.extend({ totpCode: totpCodeSchema });

/** The first step's form: the password, plus the 6-digit code when `withCode` (disable). */
export function passwordStepSchema(withCode: boolean) {
  return z
    .object({ currentPassword: currentPasswordSchema, totpCode: z.string().optional() })
    .superRefine((value, ctx) => {
      if (withCode && !totpCodeSchema.safeParse(value.totpCode ?? '').success) {
        ctx.addIssue({ code: 'custom', path: ['totpCode'], message: TOTP_CODE_MESSAGE });
      }
    });
}
export type PasswordFormValues = z.infer<ReturnType<typeof passwordStepSchema>>;
export const codeFormSchema = z.object({ code: otpCodeSchema });
export type CodeFormValues = z.infer<typeof codeFormSchema>;

/** The 403 error code the API sends for a wrong current password. */
export const REAUTH_FAILED_CODE = 'REAUTH_FAILED';
/** 403 for disable on a role that must keep 2FA (checked after the password). */
export const ROLE_REQUIRED_CODE = 'TWO_FACTOR_REQUIRED_FOR_ROLE';
/** The only text shown for REAUTH_FAILED, inside the dialog. */
export const REAUTH_FAILED_MESSAGE = 'Password incorrect';
/** Disable: the server does not say whether the password or the code was wrong. */
export const REAUTH_FAILED_DISABLE_MESSAGE = 'Password or code incorrect';

/** FR-102: 2FA is mandatory for these roles, so it cannot be turned off. [ARC-02] shared constant. */
export const TWO_FACTOR_MANDATORY_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'REVIEWER'];
export function isTwoFactorMandatory(role: UserRole | null | undefined): boolean {
  return role !== null && role !== undefined && TWO_FACTOR_MANDATORY_ROLES.includes(role);
}
