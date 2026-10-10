import { EVENT_TYPES, MAX_EMAIL_LENGTH, USER_ROLES } from '@codeproctor/shared';
import { z } from 'zod';

/*
 * Web-local form schemas for the Settings pages (FR-103, FR-704, FR-804, D-17, D-19). The bounds
 * follow docs/database.md (retention 7..730 days) and ADR 0005 / ADR 0007 section 6.
 * [ARC-02] Move `OrgSettings` and these schemas into packages/shared so the API and the form
 * validate the same rules (ADR 0007 section 6 already says shared defines OrgSettings).
 */

const whole = (label: string, min: number, max: number) =>
  z
    .number({ error: `Enter a whole number for ${label}.` })
    .int(`Enter a whole number for ${label}.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);

// InviteStaffUserDto: name 1..200 (apps/api/src/users/dto/users.dto.ts).
export const MAX_STAFF_NAME_LENGTH = 200;

export const inviteStaffSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter the work email of the person you are inviting.')
    .max(MAX_EMAIL_LENGTH, 'That email is too long.')
    .pipe(z.email('Enter a valid email, like name@company.com.')),
  name: z
    .string()
    .trim()
    .min(1, 'Enter their full name.')
    .max(MAX_STAFF_NAME_LENGTH, `Use at most ${MAX_STAFF_NAME_LENGTH} characters.`),
  role: z.enum(USER_ROLES, { error: 'Choose a role.' }),
});
export type InviteStaffValues = z.infer<typeof inviteStaffSchema>;

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 730;
export const dataSettingsSchema = z.object({
  retentionDays: whole('retention days', RETENTION_MIN_DAYS, RETENTION_MAX_DAYS),
  holdWhileReviewOrAppealOpen: z.boolean(),
});
export type DataSettingsValues = z.infer<typeof dataSettingsSchema>;

export const riskSettingsSchema = z
  .object({
    pointsLow: whole('LOW points', 0, 100),
    pointsMedium: whole('MEDIUM points', 0, 100),
    pointsHigh: whole('HIGH points', 0, 100),
    capPerType: whole('the cap per event type', 1, 20),
    mediumFrom: whole('the MEDIUM threshold', 1, 99),
    highFrom: whole('the HIGH threshold', 2, 100),
    weights: z.record(
      z.enum(EVENT_TYPES),
      z
        .number({ error: 'Enter a number from 0 to 5.' })
        .min(0, 'Use 0 or more.')
        .max(5, 'Use 5 or less.'),
    ),
  })
  .refine((v) => v.mediumFrom < v.highFrom, {
    path: ['highFrom'],
    error: 'The HIGH threshold must be higher than the MEDIUM threshold.',
  });
export type RiskSettingsValues = z.infer<typeof riskSettingsSchema>;

export const MAX_CONSENT_VERSION_LENGTH = 40;
export const MAX_CONSENT_BODY_LENGTH = 50_000;
export const consentVersionSchema = z.object({
  version: z
    .string()
    .trim()
    .min(1, 'Name this version, for example v1.1.')
    .max(MAX_CONSENT_VERSION_LENGTH, `Use at most ${MAX_CONSENT_VERSION_LENGTH} characters.`),
  bodyMd: z
    .string()
    .trim()
    .min(20, 'Paste the full consent text (at least 20 characters).')
    .max(
      MAX_CONSENT_BODY_LENGTH,
      `The text is too long (at most ${MAX_CONSENT_BODY_LENGTH} characters).`,
    ),
});
export type ConsentVersionValues = z.infer<typeof consentVersionSchema>;

export const MAX_DECLINE_CONTACT_LENGTH = 300;
export const declineContactSchema = z.object({
  consentDeclineContact: z
    .string()
    .trim()
    .min(3, 'Enter who a candidate can contact, for example an email address.')
    .max(MAX_DECLINE_CONTACT_LENGTH, `Use at most ${MAX_DECLINE_CONTACT_LENGTH} characters.`),
});
export type DeclineContactValues = z.infer<typeof declineContactSchema>;
