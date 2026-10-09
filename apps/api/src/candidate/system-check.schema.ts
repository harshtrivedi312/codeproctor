// The body of POST /candidate/session/system-check (ADR 0013 section 5.4). Strict: an unknown key is
// a 400. The finding payloads are validated by the shared payload schema of their event type, so the
// server never stores a shape the review does not know (ADR 0010).
import { EVENT_PAYLOAD_SCHEMAS } from '@codeproctor/shared';
import { z } from 'zod';

export const CAPABILITY_STATUSES = ['SUPPORTED', 'UNSUPPORTED', 'DENIED', 'UNVERIFIABLE'] as const;
export const SYSTEM_CHECK_FINDING_TYPES = ['MULTI_MONITOR', 'VIRTUAL_CAMERA'] as const;

// A NUL character makes Postgres jsonb fail (22P05): refuse it as a 400 instead of a 500.
const noNul = (value: unknown): boolean => !JSON.stringify(value).includes('\\u0000');

const capabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    status: z.enum(CAPABILITY_STATUSES),
    // Untrusted text: rendered as plain text only (ADR 0013 section 5.8).
    detail: z.string().max(128).refine(noNul).optional(),
  })
  .strict();

const findingSchema = z
  .object({
    type: z.enum(SYSTEM_CHECK_FINDING_TYPES),
    occurredAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  // The stored payload is the PARSED, STRIPPED value of the shared schema (ADR 0010): unknown keys
  // are dropped, so a candidate cannot put arbitrary JSON in an evidence row, and the dedupe
  // fingerprint is computed from the same canonical value.
  .transform((finding, ctx) => {
    const parsed = EVENT_PAYLOAD_SCHEMAS[finding.type].safeParse(finding.payload);
    if (!parsed.success || !noNul(parsed.data)) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'invalid payload' });
      return z.NEVER;
    }
    return { type: finding.type, occurredAt: finding.occurredAt, payload: parsed.data };
  });

export const systemCheckBodySchema = z
  .object({
    browser: z
      .object({
        brand: z.string().trim().min(1).max(64).refine(noNul),
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
    capabilities: z
      .array(capabilitySchema)
      .max(32)
      .refine((list) => new Set(list.map((c) => c.id)).size === list.length, {
        message: 'duplicate capability id',
      }),
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
