// The email queue seam (DL-33). Callers and the processor depend on EmailQueuePort only.
//
// Today the implementation is InProcessEmailQueue (in memory, bounded concurrency, retries with
// exponential backoff, a job is dropped on completion or after its final attempt). BullMQ is not on
// main yet. To swap it in: add a BullEmailQueue implementing EmailQueuePort (queue name `email`,
// removeOnComplete and removeOnFail true, attempts and exponential backoff from the same options,
// the same MailProcessor.handle as the worker function) and change the one provider in
// mail.module.ts. Both implementations must keep the payload out of logs, errors and any stored
// record other than the queue's own job data (which is removed when the job ends).
import type { EmailJob } from './mail-templates';

/** 'accepted': the queue holds the job. 'rejected': the queue is full or stopped. */
export type EnqueueOutcome = 'accepted' | 'rejected';

export abstract class EmailQueuePort {
  /** Resolves once the job is accepted, not when it is delivered. */
  abstract enqueue(job: EmailJob): Promise<EnqueueOutcome>;
}

/** Processes one job; throws a payload-free error to request a retry. */
export type EmailJobHandler = (job: EmailJob) => Promise<void>;
