import { z } from 'zod';

/**
 * Web-local form schemas (packages/shared has no candidate schemas yet; moving these there is a
 * shared-contract change that goes through the hub, see docs/followups/frontend.md).
 */

/** Spaces and dashes people paste from the email are dropped before the 6-digit check. */
export const otpFormSchema = z.object({
  otp: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6 digits from the email, for example 123456.')),
});
export type OtpFormInput = z.input<typeof otpFormSchema>;
export type OtpFormValues = z.output<typeof otpFormSchema>;
