// The body of POST /candidate/session/system-check (ADR 0013 section 5.4). Strict: an unknown key is
// a 400. The finding payloads are validated by the shared payload schema of their event type, so the
// server never stores a shape the review does not know (ADR 0010).
import { EVENT_PAYLOAD_SCHEMAS } from '@codeproctor/shared';
import { z } from 'zod';

export const CAPABILITY_STATUSES = ['SUPPORTED', 'UNSUPPORTED', 'DENIED', 'UNVERIFIABLE'] as const;
export const SYSTEM_CHECK_FINDING_TYPES = ['MULTI_MONITOR', 'VIRTUAL_CAMERA'] as const;

const capabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    status: z.enum(CAPABILITY_STATUSES),
    // Untrusted text: rendered as plain text only (ADR 0013 section 5.8).
    detail: z.string().max(128).optional(),
  })
  .strict();

const findingSchema = z
  .object({
    type: z.enum(SYSTEM_CHECK_FINDING_TYPES),
    occurredAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (!EVENT_PAYLOAD_SCHEMAS[finding.type].safeParse(finding.payload).success) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'invalid payload' });
    }
  });

export const systemCheckBodySchema = z
  .object({
    browser: z
      .object({
        brand: z.string().trim().min(1).max(64),
        majorVersion: z.int().min(0).max(999),
      })
      .strict(),
    network: z
      .object({ downlinkKbps: z.number().min(0).max(1e7), rttMs: z.number().min(0).max(1e5) })
      .strict()
      .optional(),
    devices: z
      .object({
        camera: z.boolean(),
        microphone: z.boolean(),
        screenShare: z.enum(['MONITOR', 'OTHER', 'UNVERIFIABLE']),
      })
      .strict(),
    findings: z.array(findingSchema).max(4),
    capabilities: z.array(capabilitySchema).max(32),
  })
  .strict();

export type SystemCheckInput = z.infer<typeof systemCheckBodySchema>;

export const BLOCKING_REASONS = [
  'MULTI_MONITOR',
  'BROWSER_UNSUPPORTED',
  'SCREEN_SHARE_NOT_MONITOR',
  'DEVICE_MISSING',
] as const;
export type BlockingReason = (typeof BLOCKING_REASONS)[number];

export interface SystemCheckResult {
  readonly passed: boolean;
  readonly blocking: readonly BlockingReason[];
}
