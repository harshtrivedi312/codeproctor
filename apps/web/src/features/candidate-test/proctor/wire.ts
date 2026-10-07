import { z } from 'zod';
import { sessionStateSchema } from '../adr-wire';

/**
 * PROVISIONAL wire shapes for the proctoring routes (ADR 0013 sections 4, 5.2, 5.3, 5.5), parsed at
 * the boundary. Nothing here is ever logged: the key response carries the HMAC key, the heartbeat
 * response can carry a renewed session token, and presign responses carry upload URLs.
 */

/** Where each recording stream continues (ADR 0013 section 2, counters). */
const mediaCounterSchema = z.object({
  nextSeq: z.number().int().nonnegative(),
  nextSegment: z.number().int().nonnegative(),
});

/** POST /candidate/session/proctor-key (ADR 0013 section 4). The key is base64, 32 bytes. */
export const proctorKeySchema = z.object({
  alg: z.literal('HMAC-SHA256'),
  key: z.string().min(40).max(64),
  keyEpoch: z.number().int().nonnegative(),
  counters: z
    .object({
      eventSeqStart: z.number().int().nonnegative().optional(),
      keystrokeSeqStart: z.number().int().nonnegative().optional(),
      media: z
        .object({
          SCREEN: mediaCounterSchema.optional(),
          WEBCAM: mediaCounterSchema.optional(),
          AUDIO: mediaCounterSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

/** POST /candidate/session/heartbeat (ADR 0013 section 5.3). */
export const heartbeatSchema = sessionStateSchema.extend({
  sessionToken: z.string().optional(),
  sessionTokenExpiresAt: z.string().optional(),
});
export type HeartbeatState = z.infer<typeof heartbeatSchema>;

/** Pause reasons the server can hold (ADR 0002 P-1, ADR 0013 5.10). */
export type ProctorKey = z.infer<typeof proctorKeySchema>;

export const PROCTOR_PAUSE = 'PROCTOR';
