import { z } from 'zod';

/** Web-local (packages/shared has no consent schemas yet). Mirrors BE-07 `SignConsentDto`. */
export const consentFormSchema = z.object({
  signedName: z
    .string()
    .trim()
    .min(2, 'Type your full legal name, at least 2 characters.')
    .max(200, 'Your name is too long. Use at most 200 characters.'),
  confirmedAge18: z.boolean().refine((v) => v, {
    message:
      'Confirm that you are 18 or older. If you are under 18 you cannot take this test: please contact your recruiter.',
  }),
});
export type ConsentFormValues = z.infer<typeof consentFormSchema>;
