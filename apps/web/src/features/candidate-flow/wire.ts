import { codeLanguageSchema } from '@codeproctor/shared';
import { z } from 'zod';
import { runResponseSchema } from '@/features/candidate-test/adr-wire';
import { isAllowedUploadUrl } from './upload-url';

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
 * POST /candidate/session/identity/presign (apps/api identity.dto.ts IdentityPresignedDto; D-61 made
 * these routes canonical, ADR 0013 section 5.6): a single-use `name` (identity/<attempt>/<id|selfie>-
 * <ULID>.jpg, NOT an object key) and a 60 s PUT URL. PUT the file with exactly `headers`.
 */
export const presignSchema = z.object({
  // https only; plain http only for localhost in a development build (see upload-url.ts).
  url: z
    .string()
    .url()
    .refine((u) => isAllowedUploadUrl(u), { message: 'Upload URL not allowed' }),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  name: z.string().min(1),
  attempt: z.number().int().min(1),
  expiresAt: z.string(),
});
export type Presign = z.infer<typeof presignSchema>;

/**
 * POST /candidate/session/identity (202) and GET /candidate/session/identity (IdentityStatusDto).
 * Status only: never a score, a threshold, a model id or a reason (NFR-05, D-05). The match runs in
 * the background, so a submit answers PENDING first and the page polls the GET until it leaves
 * PENDING. LOW_CONFIDENCE with canRetry means "take both photos again, once"; MANUAL_REVIEW and
 * REVIEWED mean a person looks, which is not a failure; WAIVED means skip the step.
 */
export const IDENTITY_STATUSES = [
  'NOT_STARTED',
  'PENDING',
  'PASSED',
  'LOW_CONFIDENCE',
  'MANUAL_REVIEW',
  'REVIEWED',
  'WAIVED',
] as const;
export const identityStatusSchema = z.object({
  attempt: z.number().int().min(0).max(2),
  status: z.enum(IDENTITY_STATUSES),
  canRetry: z.boolean(),
});
export type IdentityStatus = z.infer<typeof identityStatusSchema>;

export const testStartedSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'PAUSED']),
  serverTime: z.string(),
});

/** ADR 0013 section 5.5: presign and confirm for recorded media. Room scan is stream ROOM_SCAN. */
export const mediaPresignSchema = z.union([
  z.object({ alreadyUploaded: z.literal(true) }),
  z.object({
    url: z
      .string()
      .url()
      .refine((u) => isAllowedUploadUrl(u), { message: 'Upload URL not allowed' }),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
]);
export type MediaPresign = z.infer<typeof mediaPresignSchema>;

export const mediaConfirmSchema = z.object({ uploaded: z.literal(true), sizeBytes: z.number() });

/**
 * PROVISIONAL (ARC-03 part 2, STRICT side-camera device auth is not decided). Whether this session
 * needs a phone side camera, and whether one is paired.
 */
export const sideCameraStatusSchema = z.object({ required: z.boolean(), connected: z.boolean() });
export type SideCameraStatus = z.infer<typeof sideCameraStatusSchema>;

/** PROVISIONAL: a short-lived single-use link token for the phone page. Never logged or stored. */
export const sideCameraLinkSchema = z.object({
  // The phone page accepts exactly this shape (candidate-phone/phone-store.ts).
  linkToken: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  expiresAt: z.string(),
});

/** PROVISIONAL: the phone presents the link token (no candidate session token on the phone). */
export const sideCameraPairSchema = z.object({ paired: z.literal(true) });

/**
 * PROVISIONAL (FR-406): the practice question. Served from fixed content, never from the test, and
 * nothing the candidate does with it is stored, timed or graded.
 */
export const practiceQuestionSchema = z.object({
  title: z.string(),
  statementMarkdown: z.string(),
  languages: z.array(codeLanguageSchema).min(1),
  starterCode: z.record(z.string(), z.string()),
  sampleTests: z.array(
    z.object({ id: z.string(), name: z.string(), input: z.string(), expectedOutput: z.string() }),
  ),
});
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;

/**
 * Practice run (Backend A's route, #342). The shape is not final: accept both the screen's own shape
 * (`{outcome, tests, stdout, stderr}` plus `stub`/`message` for the local stub) and the answers-run
 * response with a verdict per sample, mapped the same way as the real test.
 */
export const practiceRunSchema = runResponseSchema;
