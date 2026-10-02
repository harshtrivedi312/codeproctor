import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CLIENT_EVENT_TYPES,
  DEFAULT_EVENT_CAP_PER_TYPE,
  DEFAULT_EVENT_SEVERITY,
  DEFAULT_EVENT_WEIGHT,
  DEFAULT_SEVERITY_POINTS,
  EVENT_SOURCES,
  EVENT_TYPES,
  IDENTITY_REVIEW_REASONS,
  MAX_EVENTS_PER_BATCH,
  RISK_BANDS,
  SERVER_EVENT_TYPES,
  SEVERITIES,
  clientProctorEventSchema,
  parseEventPayload,
  proctorEventBatchSchema,
  riskBandForScore,
  shouldPushToLive,
  type EventType,
} from './index';
import { USER_ROLES } from './permissions';

const SCHEMA = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');

function prismaEnum(name: string): string[] {
  const body = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(SCHEMA)?.[1];
  if (body === undefined) throw new Error(`enum ${name} not found in prisma/schema.prisma`);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

const AT = '2026-10-02T10:00:00.000Z';
const UUID = '3f0e3c2a-6b1d-4c8e-9f2a-1b2c3d4e5f60';

void describe('enums match the database (docs/database.md, prisma/schema.prisma)', () => {
  void it('FR-801: event_type, severity and event_source', () => {
    assert.deepEqual([...EVENT_TYPES], prismaEnum('EventType'));
    assert.deepEqual([...SEVERITIES], prismaEnum('Severity'));
    assert.deepEqual([...EVENT_SOURCES], prismaEnum('EventSource'));
  });
  void it('FR-804: risk_band; FR-403: identity_review_reason', () => {
    assert.deepEqual([...RISK_BANDS], prismaEnum('RiskBand'));
    assert.deepEqual([...IDENTITY_REVIEW_REASONS], prismaEnum('IdentityReviewReason'));
  });
  void it('FR-103: user_role', () => {
    assert.deepEqual([...USER_ROLES], prismaEnum('UserRole'));
  });
});

void describe('event sources (ADR 0010 §1)', () => {
  void it('every type has at least one source', () => {
    const covered = new Set<EventType>([...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES]);
    assert.deepEqual([...covered].sort(), [...EVENT_TYPES].sort());
  });
  void it('the client union accepts exactly the client types', () => {
    for (const type of EVENT_TYPES) {
      const isClient = (CLIENT_EVENT_TYPES as readonly EventType[]).includes(type);
      const r = clientProctorEventSchema.safeParse({ type, occurredAt: AT, payload: {} });
      // A rejected client type fails on the discriminator, not only on its payload.
      const discriminatorRejected =
        !r.success && r.error.issues.some((i) => i.code === 'invalid_union');
      assert.equal(discriminatorRejected, !isClient, type);
    }
  });
  void it('FR-106, TC-097: a client cannot send RESUME_OTP_FAILED or other server-only types', () => {
    for (const type of ['RESUME_OTP_FAILED', 'PASTE_BURST', 'PROCTOR_PAUSE', 'CODE_SIMILARITY']) {
      assert.equal(
        clientProctorEventSchema.safeParse({ type, occurredAt: AT, payload: {} }).success,
        false,
      );
    }
  });
});

void describe('default severities and weights (ADR 0005 §2)', () => {
  void it('FR-801: TC-055 SCREEN_SHARE_STOPPED and TC-058 MULTIPLE_FACES are HIGH', () => {
    assert.equal(DEFAULT_EVENT_SEVERITY.SCREEN_SHARE_STOPPED, 'HIGH');
    assert.equal(DEFAULT_EVENT_SEVERITY.MULTIPLE_FACES, 'HIGH');
    assert.equal(DEFAULT_EVENT_SEVERITY.PASTE_ATTEMPT, 'LOW');
    assert.equal(DEFAULT_EVENT_SEVERITY.TAB_SWITCH, 'MEDIUM');
  });
  void it('informational and resume types have weight 0', () => {
    for (const t of [
      'DISCONNECTED',
      'PROCTOR_RESUME',
      'IDENTITY_MANUAL_REVIEW',
      'RESUME_OTP_FAILED',
    ] as const) {
      assert.equal(DEFAULT_EVENT_WEIGHT[t], 0, t);
    }
    assert.equal(DEFAULT_EVENT_WEIGHT.PHONE_DETECTED, 1);
  });
  void it('FR-804, TC-075: 2 HIGH + 3 MEDIUM scores 64, band HIGH', () => {
    const score =
      Math.min(2, DEFAULT_EVENT_CAP_PER_TYPE) * DEFAULT_SEVERITY_POINTS.HIGH +
      Math.min(3, DEFAULT_EVENT_CAP_PER_TYPE) * DEFAULT_SEVERITY_POINTS.MEDIUM;
    assert.equal(score, 64);
    assert.equal(riskBandForScore(score), 'HIGH');
  });
  void it('FR-804: band edges 29/30 and 59/60', () => {
    assert.equal(riskBandForScore(0), 'LOW');
    assert.equal(riskBandForScore(29), 'LOW');
    assert.equal(riskBandForScore(30), 'MEDIUM');
    assert.equal(riskBandForScore(59), 'MEDIUM');
    assert.equal(riskBandForScore(60), 'HIGH');
    assert.equal(riskBandForScore(150), 'HIGH');
  });
  void it('FR-903, TC-097: HIGH events and RESUME_OTP_FAILED go to /live', () => {
    assert.equal(shouldPushToLive('PHONE_DETECTED', 'HIGH'), true);
    assert.equal(shouldPushToLive('RESUME_OTP_FAILED', 'MEDIUM'), true);
    assert.equal(shouldPushToLive('TAB_SWITCH', 'MEDIUM'), false);
  });
});

void describe('client event envelope', () => {
  void it('FR-602: TAB_SWITCH with duration parses', () => {
    const r = clientProctorEventSchema.parse({
      type: 'TAB_SWITCH',
      occurredAt: AT,
      durationMs: 4200,
      payload: {},
    });
    assert.equal(r.type, 'TAB_SWITCH');
  });
  void it('FR-801: client severity is ignored (stripped), never stored', () => {
    const r = clientProctorEventSchema.parse({
      type: 'RIGHT_CLICK',
      occurredAt: AT,
      severity: 'LOW',
      payload: {},
    });
    assert.equal('severity' in r, false);
  });
  void it('FR-603, TC-053: DROP_ATTEMPT keeps the length and drops any content', () => {
    const r = clientProctorEventSchema.parse({
      type: 'DROP_ATTEMPT',
      occurredAt: AT,
      payload: { length: 12, text: 'secret' },
    });
    assert.deepEqual(r.payload, { length: 12 });
  });
  void it('FR-606: confidence must be 0-1 and payload must match the type', () => {
    assert.equal(
      clientProctorEventSchema.safeParse({
        type: 'MULTIPLE_FACES',
        occurredAt: AT,
        confidence: 1.5,
        payload: { faceCount: 2 },
      }).success,
      false,
    );
    assert.equal(
      clientProctorEventSchema.safeParse({ type: 'MULTIPLE_FACES', occurredAt: AT, payload: {} })
        .success,
      false,
    );
  });
  void it('rejects a non-UTC timestamp and a path-traversal evidence key', () => {
    const base = { type: 'NO_FACE', payload: {} };
    assert.equal(
      clientProctorEventSchema.safeParse({ ...base, occurredAt: '2026-10-02 10:00' }).success,
      false,
    );
    assert.equal(
      clientProctorEventSchema.safeParse({ ...base, occurredAt: AT, evidenceKey: 'a/../b' })
        .success,
      false,
    );
  });
});

void describe('event batch (backend.md Step 10, ADR 0005 §3)', () => {
  const event = { type: 'FOCUS_LOST', occurredAt: AT, payload: {} };
  void it('FR-801: accepts 1..100 events with a non-negative int seq', () => {
    assert.equal(proctorEventBatchSchema.safeParse({ seq: 0, events: [event] }).success, true);
    assert.equal(
      proctorEventBatchSchema.safeParse({
        seq: 1,
        events: Array.from({ length: MAX_EVENTS_PER_BATCH }, () => event),
      }).success,
      true,
    );
  });
  void it('TC-065: rejects empty, oversized and malformed batches', () => {
    assert.equal(proctorEventBatchSchema.safeParse({ seq: 0, events: [] }).success, false);
    assert.equal(
      proctorEventBatchSchema.safeParse({
        seq: 0,
        events: Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => event),
      }).success,
      false,
    );
    assert.equal(proctorEventBatchSchema.safeParse({ seq: -1, events: [event] }).success, false);
    assert.equal(proctorEventBatchSchema.safeParse({ seq: 1.5, events: [event] }).success, false);
  });
});

void describe('server payloads', () => {
  void it('ADR 0005 AI-1: AI_LIKENESS cites the AI reference solution', () => {
    assert.throws(() =>
      parseEventPayload('AI_LIKENESS', { sessionQuestionId: UUID, similarity: 0.9 }),
    );
    const p = parseEventPayload('AI_LIKENESS', {
      sessionQuestionId: UUID,
      similarity: 0.9,
      aiReferenceSolutionId: UUID,
    });
    assert.equal(p.aiReferenceSolutionId, UUID);
  });
  void it('FR-106, TC-097: RESUME_OTP_FAILED never carries the code', () => {
    assert.deepEqual(parseEventPayload('RESUME_OTP_FAILED', { otp: '123456' }), {});
  });
});
