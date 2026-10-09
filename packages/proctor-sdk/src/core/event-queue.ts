import {
  MAX_EVENTS_PER_BATCH,
  clientProctorEventSchema,
  type ClientProctorEvent,
} from '@codeproctor/shared';
import {
  BatchQueue,
  type BatchQueueOptions,
  type BatchQueueSpec,
  type BatchQueueStats,
} from './batch-queue';
import { canonicalJson } from './canonical';

export type { EndReason, SendOutcome, SendResult, SignedBatch } from './batch-queue';
import type { SendResult, SignedBatch } from './batch-queue';

/** Sends one signed event batch (POST /candidate/session/events). */
export interface EventTransport {
  sendBatch(batch: SignedBatch): Promise<SendResult>;
}

export interface EventQueueOptions extends Omit<BatchQueueOptions, 'transport'> {
  transport: EventTransport;
  maxBatchSize?: number;
}

export interface EventQueueStats extends BatchQueueStats {
  pendingEvents: number;
  droppedInvalidEvents: number;
}

/**
 * Batches proctor events every 5 s or 100 events (FR-601 area, ADR 0001 F4): see BatchQueue for the
 * signing, persistence, retry and finish guarantees (TC-063, NFR-08).
 */
export class EventQueue extends BatchQueue<ClientProctorEvent> {
  constructor(opts: EventQueueOptions) {
    const max = Math.min(opts.maxBatchSize ?? MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH);
    const spec: BatchQueueSpec<ClientProctorEvent> = {
      keyInfix: '',
      metaName: 'nextEventSeq',
      backupPrefix: 'codeproctor:eventseq:',
      flushAt: max,
      accept: (item) => {
        const parsed = clientProctorEventSchema.safeParse(item);
        return parsed.success ? parsed.data : null;
      },
      cut: (pending, seq) => {
        const events = pending.slice(0, max);
        return { body: canonicalJson({ seq, events }), consumed: events.length };
      },
    };
    super(opts, spec);
  }

  override stats(): EventQueueStats {
    const s = super.stats();
    return { ...s, pendingEvents: s.pendingItems, droppedInvalidEvents: s.droppedInvalidItems };
  }
}
