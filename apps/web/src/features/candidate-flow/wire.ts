import { z } from 'zod';
import { mockingEnabled } from '@/lib/env';

/**
 * PROVISIONAL wire contract for the candidate pre-test routes (contract not final).
 *
 * Sources: ADR 0013 sections 5.1, 5.4, 5.6 and 5.10, fsd.md section 4, and the BE-07 branch DTOs
 * (apps/api/src/candidate/dto/candidate.dto.ts, backend-cand/be-07-session, not on main yet).
 * Routes with no backend DTO yet (accommodations projection, identity upload and result) are
 * the web's best reading of ADR 0004, 0013 and 0015 and are marked below. When the generated
 * client covers these routes (ADR 0012), replace this file with the generated types and delete
 * src/mocks/candidate.
 *
 * Responses are parsed with zod at the boundary so a drifting backend fails loudly, not silently.
 */

export const linkStateSchema = z.enum([
  'OTP_REQUIRED',
  'ALREADY_USED',
  'EXPIRED',
  'DECLINED',
  'BLOCKED',
  'NOT_YET_OPEN',
]);
export type LinkState = z.infer<typeof linkStateSchema>;

export const linkViewSchema = z.object({
  state: linkStateSchema,
  orgName: z.string(),
  declineContact: z.string().nullable(),
  retryAfterSeconds: z.number().nullable(),
  windowStart: z.string(),
  windowEnd: z.string(),
});
export type LinkView = z.infer<typeof linkViewSchema>;

export const otpSentSchema = z.object({
  state: z.union([z.literal('OTP_SENT'), linkStateSchema]),
  maskedEmail: z.string().nullable(),
  expiresInSeconds: z.number(),
  retryAfterSeconds: z.number().nullable(),
  declineContact: z.string().nullable(),
});
export type OtpSent = z.infer<typeof otpSentSchema>;

export const sessionStatusSchema = z.enum([
  'OPENED',
  'CONSENTED',
  'VERIFIED',
  'IN_PROGRESS',
  'PAUSED',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionTokenSchema = z.object({
  sessionToken: z.string().min(1),
  sessionTokenExpiresAt: z.string(),
  status: sessionStatusSchema,
  serverTime: z.string(),
});
export type SessionTokenResponse = z.infer<typeof sessionTokenSchema>;

export const consentDocumentSchema = z.object({
  consentTextId: z.string().uuid(),
  version: z.string(),
  bodyMd: z.string(),
  legalApproved: z.boolean(),
  /** PROVISIONAL: the task brief also names a `legalApprovalRequired` flag. Either one blocks. */
  legalApprovalRequired: z.boolean().optional(),
  signed: z.boolean(),
  signedAt: z.string().nullable(),
});
export type ConsentDocument = z.infer<typeof consentDocumentSchema>;

export const consentSignedSchema = z.object({
  status: z.literal('CONSENTED'),
  signedAt: z.string(),
});

export const consentDeclinedSchema = z.object({
  status: z.literal('DECLINED'),
  declineContact: z.string().nullable(),
});
export type ConsentDeclined = z.infer<typeof consentDeclinedSchema>;

/** PROVISIONAL (ADR 0015 S4): what the candidate client may know about accommodations. */
export const accommodationsProjectionSchema = z.object({
  identityCheckWaived: z.boolean(),
  faceDetectorsOff: z.boolean(),
});
export type AccommodationsProjection = z.infer<typeof accommodationsProjectionSchema>;

/** ADR 0013 section 5.4. */
export const systemCheckResultSchema = z.object({
  passed: z.boolean(),
  blocking: z.array(
    z.enum(['MULTI_MONITOR', 'BROWSER_UNSUPPORTED', 'SCREEN_SHARE_NOT_MONITOR', 'DEVICE_MISSING']),
  ),
});
export type SystemCheckResult = z.infer<typeof systemCheckResultSchema>;
export type BlockingReason = SystemCheckResult['blocking'][number];

export interface SystemCheckBody {
  browser: { brand: string; majorVersion: number };
  network?: { downlinkKbps: number; rttMs: number };
  devices: {
    camera: boolean;
    microphone: boolean;
    screenShare: 'MONITOR' | 'OTHER' | 'UNVERIFIABLE';
  };
  findings: { type: 'MULTI_MONITOR' | 'VIRTUAL_CAMERA'; occurredAt: string; payload: object }[];
  capabilities: { id: string; status: 'SUPPORTED' | 'UNSUPPORTED' | 'DENIED' | 'UNVERIFIABLE' }[];
}

/**
 * ADR 0013 section 5.6: the initial ID and selfie upload uses the evidence presign shape with
 * purpose ID_IMAGE or SELFIE (at most 5 MiB). The route for these purposes is pinned by BE-08, so
 * its path here is PROVISIONAL.
 */
export const presignSchema = z.object({
  // Real uploads are https only. Plain http is accepted with mocks on (localhost mock upload).
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || (mockingEnabled && u.startsWith('http://')), {
      message: 'Upload URL must be https',
    }),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  evidenceKey: z.string().min(1),
  expiresAt: z.string(),
});
export type Presign = z.infer<typeof presignSchema>;

/**
 * PROVISIONAL (BE-08 pins this). Per ADR 0004 and FR-403 the candidate sees only that the photos
 * were received. `retrySuggested` is true once, when the first attempt could not be read well; it
 * carries no score and no reason a candidate could game.
 */
export const identityReceivedSchema = z.object({
  status: z.literal('RECEIVED'),
  attempt: z.number().int().min(1).max(2),
  retrySuggested: z.boolean(),
});
export type IdentityReceived = z.infer<typeof identityReceivedSchema>;

export const testStartedSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'PAUSED']),
  serverTime: z.string(),
});
