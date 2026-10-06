// The validate job (FR-203, ADR 0007 V-3, TC-012; BE-04 slice 4c, FU-BE-101, FU-BE-119).
//
// Flow. POST starts a job: inside ONE transaction that holds the question row lock it computes the
// revision of the draft (revision.ts, variants included), builds what to run, clears the previous
// result (a new run can only ever turn the gate from closed to open at its end) and writes the
// audit row. The job then runs in this process, after the response (202), behind the
// ReferenceValidationPort. When it finishes it takes the question lock again and recomputes the
// revision: only a result whose revision still equals the current one is stored, and only a passing
// one sets validated_at. If the content changed meanwhile (an edit, a test case or variant change,
// a new version) the result is discarded and the job is STALE; publish keeps refusing because
// validated_at stayed null (and, as a second line, publish compares report.revision itself).
//
// Fail closed: a port that rejects, a timeout, an archived question or a published version end the
// job without validated_at. Source code, expected outputs and error messages are never logged.
//
// Limits of the in-process job (follow-up FU-BE-125): the job table lives in this instance's memory,
// so a restart forgets a running job (status then falls back to the stored report, and the author
// starts again) and two instances do not see each other's jobs. The stored result is still safe:
// it is revision-bound and written under the question lock. Swap for a BullMQ job when the
// dependency is approved.
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { QuestionVersion } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { computeRevision } from './revision';
import {
  checkRevision,
  latestVersion,
  loadVariants,
  lockWritable,
  noHistory,
  NOT_FOUND,
  requireQuestion,
} from './question-tx';
import type { Actor, Db } from './question-tx';
import { REFERENCE_VALIDATION_PORT } from './reference-validation.port';
import type { ReferenceValidationPort } from './reference-validation.port';
import { buildReport, buildRequest, errorReport } from './validation-job';
import type { BuiltRequest, StoredReport } from './validation-job';
import { asRecord } from './staff-view';
import type {
  StartValidationDto,
  ValidationStartedDto,
  ValidationStatus,
  ValidationStatusDto,
} from './dto/validation.dto';

type Built = Extract<BuiltRequest, { ok: true }>;
type JobStatus = Exclude<ValidationStatus, 'NONE'>;

interface Job {
  readonly jobId: string;
  readonly orgId: string;
  /** The author who started the run: the actor of the finish audit row (a system write). */
  readonly starterId: string;
  /** The STARTED audit row of this run (a string: audit ids are bigints). */
  readonly startedAuditId: string;
  readonly questionId: string;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
  readonly startedAt: Date;
  status: JobStatus;
  finishedAt?: Date;
}

/** Longest a run may take before it is a failed run (fail closed). */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60_000;
const MAX_FINISHED_JOBS = 500;

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);
  /** The latest job of each question in this process. */
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Set<Promise<void>>();

  /** Server time, the only clock; replaceable in tests. */
  clock: () => Date = () => new Date();
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    @Inject(REFERENCE_VALIDATION_PORT) private readonly port: ReferenceValidationPort,
  ) {}

  /** Resolves when no job is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  async start(
    actor: Actor,
    id: string,
    dto: StartValidationDto,
    ctx: RequestContext,
  ): Promise<ValidationStartedDto> {
    let registered: Job | undefined;
    try {
      const started = await this.prisma.client.$transaction(async (tx) => {
        const question = await lockWritable(tx, id);
        if (question.type !== 'CODING') {
          throw new UnprocessableEntityException('Only coding questions are validated.');
        }
        const head = await latestVersion(tx, id);
        if (!head) throw new NotFoundException(NOT_FOUND);
        if (head.isPublished) {
          throw new ConflictException('There is no draft to validate; edit the question first.');
        }
        await checkRevision(tx, head, dto.expectedRevision);
        const prior = this.jobs.get(id);
        if (prior?.status === 'RUNNING') {
          throw new ConflictException('A validation run of this question is already in progress.');
        }
        const cases = await tx.testCase.findMany({ where: { questionVersionId: head.id } });
        const variants = await loadVariants(tx, head.id);
        const built = buildRequest(head, cases, variants);
        if (!built.ok) throw new UnprocessableEntityException({ message: built.problems });
        const revision = computeRevision(head, cases, variants);
        // A new run starts from a closed gate: an earlier passing result no longer counts.
        await tx.questionVersion.updateMany({
          where: { id: head.id, isPublished: false },
          data: noHistory,
        });
        const startedRow = await tx.auditLog.create({
          data: {
            orgId: actor.orgId,
            actorId: actor.id,
            action: 'QUESTION_VALIDATION_STARTED',
            entityType: 'question',
            entityId: id,
            ip: ctx.ip ?? null,
            metadata: { version: head.version, variants: built.request.variants.length },
          },
          select: { id: true },
        });
        const job: Job = {
          jobId: randomUUID(),
          orgId: actor.orgId,
          starterId: actor.id,
          startedAuditId: startedRow.id.toString(),
          questionId: id,
          versionId: head.id,
          version: head.version,
          revision,
          startedAt: this.clock(),
          status: 'RUNNING',
        };
        // Registered before the lock is released, so a second POST sees it.
        this.register(job);
        registered = job;
        return { job, built };
      });
      const { job, built } = started;
      const p = this.run(job, built).finally(() => this.running.delete(p));
      this.running.add(p);
      return {
        jobId: job.jobId,
        status: 'RUNNING',
        revision: job.revision,
        version: job.version,
        startedAt: job.startedAt.toISOString(),
      };
    } catch (e) {
      // The transaction rolled back (or never committed): the job never existed.
      if (registered && this.jobs.get(id) === registered) this.jobs.delete(id);
      throw e;
    }
  }

  async status(id: string): Promise<ValidationStatusDto> {
    const db = this.prisma.client;
    await requireQuestion(db, id);
    const head = await latestVersion(db, id);
    if (!head) throw new NotFoundException(NOT_FOUND);
    const cases = await db.testCase.findMany({ where: { questionVersionId: head.id } });
    const variants = await loadVariants(db, head.id);
    const currentRevision = computeRevision(head, cases, variants);
    const stored = asRecord(head.validationReport);
    const job = this.jobs.get(id);
    const live = job && job.versionId === head.id ? job : undefined;
    let status: ValidationStatus = 'NONE';
    if (live) status = live.status;
    else if (stored) status = stored['passed'] === true && head.validatedAt ? 'PASSED' : 'FAILED';
    return {
      status,
      jobId: live ? live.jobId : null,
      version: head.version,
      currentRevision,
      revision: live
        ? live.revision
        : typeof stored?.['revision'] === 'string'
          ? stored['revision']
          : null,
      startedAt: live
        ? live.startedAt.toISOString()
        : typeof stored?.['startedAt'] === 'string'
          ? stored['startedAt']
          : null,
      finishedAt: live
        ? (live.finishedAt?.toISOString() ?? null)
        : typeof stored?.['finishedAt'] === 'string'
          ? stored['finishedAt']
          : null,
      validatedAt: head.validatedAt ? head.validatedAt.toISOString() : null,
      report: stored,
    };
  }

  // ---- the job --------------------------------------------------------------------------------

  private async run(job: Job, built: Built): Promise<void> {
    let report: StoredReport | undefined;
    try {
      const result = await this.withTimeout(this.port.validate(built.request));
      report = buildReport(built, result, {
        revision: job.revision,
        startedAt: job.startedAt,
        finishedAt: this.clock(),
      });
    } catch (e) {
      const timedOut = e instanceof ValidationTimeout;
      // Class name only: an error message could carry source code or outputs.
      this.logger.warn(
        `validation of question ${job.questionId} did not complete: ${timedOut ? 'timeout' : e instanceof Error ? e.name : 'unknown'}`,
      );
      report = errorReport(timedOut ? 'TIMEOUT' : 'EXECUTION_ERROR', {
        revision: job.revision,
        startedAt: job.startedAt,
        finishedAt: this.clock(),
      });
    }
    try {
      await this.orgContext.runInOrg(job.orgId, () => this.finish(job, report));
    } catch (e) {
      this.logger.error(
        `validation of question ${job.questionId} could not be stored: ${e instanceof Error ? e.name : 'unknown'}`,
      );
      job.status = 'ERROR';
      job.finishedAt = this.clock();
    }
  }

  /** Stores the result under the question lock, only when the content is still the validated one. */
  private async finish(job: Job, report: StoredReport): Promise<void> {
    const outcome = await this.prisma.client.$transaction(async (tx): Promise<JobStatus> => {
      const current = await this.currentIfWritable(tx, job);
      const stale =
        current === null ||
        current.version.id !== job.versionId ||
        current.version.isPublished ||
        current.revision !== job.revision;
      const status: JobStatus = stale
        ? 'STALE'
        : report.error
          ? 'ERROR'
          : report.passed
            ? 'PASSED'
            : 'FAILED';
      if (current !== null) {
        // The outcome outlives the report (the next run clears it). A job-written row (ADR 0001
        // C-3): actor and ip are null, the initiating user and the STARTED row are in the metadata,
        // which holds ids, the outcome and a revision prefix only (FU-BE-130).
        await tx.auditLog.create({
          data: {
            orgId: job.orgId,
            actorId: null,
            action: 'QUESTION_VALIDATION_FINISHED',
            entityType: 'question',
            entityId: job.questionId,
            ip: null,
            metadata: {
              system: true,
              initiatedBy: job.starterId,
              startedAuditId: job.startedAuditId,
              version: job.version,
              outcome: status,
              revision: job.revision.slice(0, 12),
            },
          },
        });
      }
      if (!stale) {
        await tx.questionVersion.updateMany({
          where: { id: job.versionId, isPublished: false },
          data: {
            validatedAt: report.passed ? new Date(report.finishedAt) : null,
            validationReport: report as unknown as Prisma.InputJsonObject,
          },
        });
      }
      return status;
    });
    job.status = outcome;
    job.finishedAt = this.clock();
  }

  /** The latest version and its revision under the question lock; null when the question cannot be written (archived, gone). */
  private async currentIfWritable(
    tx: Db,
    job: Job,
  ): Promise<{ version: QuestionVersion; revision: string } | null> {
    try {
      await lockWritable(tx, job.questionId);
    } catch (e) {
      if (e instanceof ConflictException || e instanceof NotFoundException) return null;
      throw e;
    }
    const version = await latestVersion(tx, job.questionId);
    if (!version) return null;
    const cases = await tx.testCase.findMany({ where: { questionVersionId: version.id } });
    const variants = await loadVariants(tx, version.id);
    return { version, revision: computeRevision(version, cases, variants) };
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ValidationTimeout()), this.timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private register(job: Job): void {
    this.jobs.set(job.questionId, job);
    if (this.jobs.size <= MAX_FINISHED_JOBS) return;
    for (const [key, j] of this.jobs) {
      if (j.status !== 'RUNNING' && key !== job.questionId) {
        this.jobs.delete(key);
        if (this.jobs.size <= MAX_FINISHED_JOBS) return;
      }
    }
  }
}

class ValidationTimeout extends Error {}
