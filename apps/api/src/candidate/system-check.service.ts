// POST /candidate/session/system-check (ADR 0013 sections 3 and 5.4; FR-402, FR-605, FR-610; TC-056).
// Stores the latest result in `sessions.device_info.systemCheck` with the SERVER time (the browser's
// clock is never trusted), merges the capability flags by id, records a Sec-CH-UA mismatch as advisory
// and writes each NEW MULTI_MONITOR / VIRTUAL_CAMERA finding as an unsigned CLIENT event row
// (batch_seq NULL, occurred_at clamped to [consent signed_at, now]). A passed check enqueues
// verify-session, which re-checks every condition itself. The two security gates (CONSENTED to
// VERIFIED and the start of the test) read what this stores.
//
// The device_info write is a compare-and-set on the value that was read (ADR 0013 section 5.3
// fencing): 0 rows means another writer got in, so it re-reads and retries; after 3 tries it answers
// 503 with Retry-After and never writes unfenced. Candidate-scope writes of device_info need the
// DeviceInfoService grant (CS-4 PR 2), so the interim org-scope exception applies (P-24, D-54).
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_EVENT_SEVERITY } from '@codeproctor/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { SessionLockRetryError } from '../database/errors';
import { PrismaService } from '../database/prisma.service';
import { sessionNotActive } from '../session/session-write-gate';
import { VerifyEnqueueScopeError, VerifySessionJobs } from '../session/verify-session.jobs';
import { CandidateScope } from './candidate-scope';
import type { CandidateContext } from './candidate.types';
import type { BlockingReason, SystemCheckInput, SystemCheckResult } from './system-check.schema';

const MAX_ATTEMPTS = 3;
/** ADR 0013 section 5.8 lists about 15 SDK ids; 64 leaves room and bounds device_info. */
const MAX_CAPABILITIES = 64;
/** Chromium-based browsers (FR-402: Chromium is required for STANDARD and STRICT). */
const CHROMIUM_BRANDS = ['chrome', 'chromium', 'edge', 'brave', 'opera', 'vivaldi'];
/** The oldest Chromium major version the SDK's monitors are supported on (FR-402; to be confirmed, FU-BEB-153). */
export const MIN_CHROMIUM_MAJOR = 110;

type Json = Prisma.InputJsonValue;
type JsonObject = { [key: string]: Json };

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** The brand names in a Sec-CH-UA header value: `"Chromium";v="124", "Google Chrome";v="124"`. */
export function brandsOfSecChUa(header: string | undefined): string[] | null {
  if (header === undefined || header.trim() === '') return null;
  const brands = [...header.matchAll(/"([^"]{1,64})"\s*;\s*v="/g)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
  return brands.length > 0 ? brands : null;
}

export function evaluateSystemCheck(body: SystemCheckInput): BlockingReason[] {
  const blocking: BlockingReason[] = [];
  if (body.findings.some((f) => f.type === 'MULTI_MONITOR')) blocking.push('MULTI_MONITOR');
  const brand = body.browser.brand.toLowerCase();
  const chromium = CHROMIUM_BRANDS.some((b) => brand.includes(b));
  if (!chromium || body.browser.majorVersion < MIN_CHROMIUM_MAJOR) {
    blocking.push('BROWSER_UNSUPPORTED');
  }
  // OTHER means the candidate picked a window or tab; UNVERIFIABLE (the browser does not report the
  // surface) is recorded as a capability and does not block (ADR 0013 section 5.8).
  if (body.devices.screenShare === 'OTHER') blocking.push('SCREEN_SHARE_NOT_MONITOR');
  if (!body.devices.camera || !body.devices.microphone) blocking.push('DEVICE_MISSING');
  return blocking;
}

/** The client's time clamped into [consent signed_at, server now] (ADR 0013 section 3). */
function clampTime(iso: string, floor: Date, now: Date): Date {
  return new Date(Math.min(Math.max(Date.parse(iso), floor.getTime()), now.getTime()));
}

function fingerprint(type: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${type}:${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 16);
}

@Injectable()
export class SystemCheckService {
  private readonly logger = new Logger(SystemCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly verify: VerifySessionJobs,
  ) {}

  async submit(
    ctx: CandidateContext,
    check: SystemCheckInput,
    secChUa: string | undefined,
    now: Date = new Date(),
  ): Promise<SystemCheckResult> {
    const blocking = evaluateSystemCheck(check);
    const passed = blocking.length === 0;
    const brands = brandsOfSecChUa(secChUa);
    const reported = check.browser.brand.toLowerCase();
    // A very short reported brand would match any GREASE brand ("Not A Brand"): count it as a mismatch.
    const uaMismatch =
      brands === null
        ? null
        : reported.length < 3 || !brands.some((b) => b.includes(reported) || reported.includes(b));

    await this.scope.asOrg(ctx, () =>
      this.store(ctx, check, { blocking, passed, uaMismatch }, now),
    );

    if (passed) {
      // The candidate scope of THIS session is the only scope the enqueue accepts (CS-4.7).
      try {
        await this.scope.asCandidate(ctx, () =>
          this.verify.enqueueVerifySession(ctx.orgId, ctx.sessionId),
        );
      } catch (e) {
        // A programming error is not "busy": it surfaces as a 500, with the class name only.
        if (e instanceof VerifyEnqueueScopeError) throw e;
        this.logger.warn(
          `verify-session was not queued (${e instanceof Error ? e.name : 'error'})`,
        );
        // The check is stored; the candidate retries and the retry is idempotent.
        throw new SessionLockRetryError();
      }
    }
    return { passed, blocking };
  }

  /**
   * One attempt = one transaction: the fenced device_info write and the new evidence rows commit
   * together, so a failed insert rolls the fingerprints back and a retry still records the finding.
   */
  private async store(
    ctx: CandidateContext,
    check: SystemCheckInput,
    outcome: { blocking: BlockingReason[]; passed: boolean; uaMismatch: boolean | null },
    now: Date,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const done = await this.prisma.client.$transaction(async (tx) => {
        const row = await tx.session.findUnique({
          where: { id: ctx.sessionId },
          select: { status: true, deviceInfo: true },
        });
        if (row === null) throw sessionNotActive(ctx.status);
        if (row.status !== 'CONSENTED' && row.status !== 'VERIFIED') {
          throw sessionNotActive(row.status);
        }
        const current = asObject(row.deviceInfo);
        const previous = asObject(current.systemCheck);
        const seen = Array.isArray(previous.findings) ? (previous.findings as unknown[]) : [];
        const prints = check.findings.map((f) => fingerprint(f.type, f.payload));
        const next: JsonObject = {
          ...current,
          systemCheck: {
            passed: outcome.passed,
            checkedAt: now.toISOString(),
            blocking: outcome.blocking,
            ...(outcome.uaMismatch === null ? {} : { uaMismatch: outcome.uaMismatch }),
            browser: { brand: check.browser.brand, majorVersion: check.browser.majorVersion },
            ...(check.network === undefined ? {} : { network: check.network }),
            findings: [...new Set(prints)],
          },
          capabilities: mergeCapabilities(current.capabilities, check.capabilities, now),
        };
        const written = await tx.session.updateMany({
          where: { id: ctx.sessionId, deviceInfo: { equals: row.deviceInfo as Json } },
          data: { deviceInfo: next },
        });
        if (written.count !== 1) return false;
        const consent = await tx.consent.findUnique({
          where: { sessionId: ctx.sessionId },
          select: { signedAt: true },
        });
        const floor = consent?.signedAt ?? now;
        // New findings only, and each distinct finding once per call.
        const taken = new Set<string>(seen.filter((x): x is string => typeof x === 'string'));
        const fresh = check.findings.filter((_, i) => {
          const print = prints[i] as string;
          if (taken.has(print)) return false;
          taken.add(print);
          return true;
        });
        if (fresh.length > 0) {
          await tx.proctorEvent.createMany({
            data: fresh.map((f) => ({
              sessionId: ctx.sessionId,
              type: f.type,
              severity: DEFAULT_EVENT_SEVERITY[f.type],
              source: 'CLIENT' as const,
              occurredAt: clampTime(f.occurredAt, floor, now),
              payload: f.payload,
              batchSeq: null,
            })),
          });
        }
        return true;
      });
      if (done) return;
    }
    // Never write unfenced: the client retries (503 with Retry-After).
    throw new SessionLockRetryError();
  }
}

function mergeCapabilities(
  stored: unknown,
  sent: SystemCheckInput['capabilities'],
  now: Date,
): Json {
  const byId = new Map<string, JsonObject>();
  for (const c of Array.isArray(stored) ? (stored as unknown[]) : []) {
    const o = asObject(c);
    if (typeof o.id === 'string') byId.set(o.id, o);
  }
  for (const c of sent) {
    // At most MAX_CAPABILITIES ids are kept per session: a new id past the cap is dropped.
    if (!byId.has(c.id) && byId.size >= MAX_CAPABILITIES) continue;
    byId.set(c.id, {
      id: c.id,
      status: c.status,
      ...(c.detail === undefined ? {} : { detail: c.detail }),
      updatedAt: now.toISOString(),
    });
  }
  return [...byId.values()];
}
