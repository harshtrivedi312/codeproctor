// GET /candidate/session/accommodations over HTTP against real Postgres 16 and Redis
// (Testcontainers). FR-305, FR-403, ADR 0015 section 4.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { CandidateTokenService } from './candidate-token.service';
import { CandidateMailPort } from './candidate-mail.port';
import { createInvitation, createTenant } from './testing/fixtures';
import type { InvitationOptions, Tenant } from './testing/fixtures';
import { InMemoryObjectStorage } from './testing/in-memory-storage';

const URL_PATH = '/api/v1/candidate/session/accommodations';

class NoMail extends CandidateMailPort {
  sendOtp(): Promise<void> {
    return Promise.resolve();
  }
  sendOtpLockout(): Promise<void> {
    return Promise.resolve();
  }
  sendConsentCopy(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Candidate accommodations projection (FR-305, FR-403, ADR 0015 section 4)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let tenant: Tenant;

  beforeAll(async () => {
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    tenant = await createTenant(owner, 'acc');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      LOG_LEVEL: 'error',
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: db.appUserUrl,
      REDIS_URL: redisBox.getConnectionUrl(),
      HEALTH_TIMEOUT_MS: '1500',
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
      COOKIE_SECRET: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      JWT_CANDIDATE_SECRET: randomBytes(32).toString('base64'),
      OTP_PEPPER: randomBytes(32).toString('base64'),
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: randomBytes(32).toString('base64'),
      CANDIDATE_TOKEN_TTL_SECONDS: '900',
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'false',
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const mailToken =
      jest.requireActual<typeof import('./candidate-mail.port')>('./candidate-mail.port');
    const storageToken =
      jest.requireActual<typeof import('./object-storage.port')>('./object-storage.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailToken.CandidateMailPort)
      .useValue(new NoMail())
      .overrideProvider(storageToken.ObjectStoragePort)
      .useValue(new InMemoryObjectStorage())
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    tokens = app.get(
      jest.requireActual<typeof import('./candidate-token.service')>('./candidate-token.service')
        .CandidateTokenService,
    );
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  async function get(options: InvitationOptions): Promise<request.Response> {
    const inv = await createInvitation(owner, tenant, { status: 'CONSENTED', ...options });
    const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
    return request(app.getHttpServer()).get(URL_PATH).set('Authorization', `Bearer ${token}`);
  }

  const EMPTY = {
    identityCheckWaived: false,
    faceDetectorsOff: false,
    disabledDetectors: [],
    gate: { idPhotoUpload: false, roomScanAlternative: false, microphoneNotRequired: false },
  };

  it('FR-305: no accommodations (the default until the PATCH exists) is all false and [], with Cache-Control no-store', async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('FR-305: an empty object and a non-object jsonb value give the empty projection, never a 500', async () => {
    const empty = await get({ accommodations: {} });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual(EMPTY);
    for (const bad of [['FACE'], 'FACE', 7]) {
      const res = await get({ accommodations: bad as never });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(EMPTY);
    }
  });

  it('FR-403: the detector list is sorted, deduplicated and enum-filtered', async () => {
    const res = await get({
      accommodations: { disabledDetectors: ['OBJECT', 'FACE', 'OBJECT', 'BOGUS-DETECTOR', 'GAZE'] },
    });
    const body = res.body as { disabledDetectors: string[]; faceDetectorsOff: boolean };
    expect(body.disabledDetectors).toEqual(['FACE', 'GAZE', 'OBJECT']);
    expect(body.faceDetectorsOff).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('BOGUS-DETECTOR');
  });

  it('FR-403: microphoneNotRequired forces VOICE into the list and sets the gate flag (ADR 0018)', async () => {
    const res = await get({
      accommodations: { microphoneNotRequired: true, disabledDetectors: ['FACE'] },
    });
    expect(res.body).toEqual({
      ...EMPTY,
      faceDetectorsOff: true,
      disabledDetectors: ['FACE', 'VOICE'],
      gate: { idPhotoUpload: false, roomScanAlternative: false, microphoneNotRequired: true },
    });
  });

  it('FR-403: the gate flags come from idPhotoUpload and the lenient roomScanAlternative', async () => {
    const res = await get({
      accommodations: {
        idPhotoUpload: true,
        roomScanAlternative: { reasonCode: 'OTHER', reasonNote: 'SECRET-ROOM' },
      },
    });
    expect(res.body).toEqual({
      ...EMPTY,
      gate: { idPhotoUpload: true, roomScanAlternative: true, microphoneNotRequired: false },
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET-ROOM');
  });

  it('FR-403: the response has exactly four top-level keys and three gate keys, and no private value', async () => {
    const res = await get({
      accommodations: {
        identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'SECRET-WAIVER-NOTE' },
        roomScanAlternative: { reasonCode: 'OTHER', reasonNote: 'SECRET-ROOM-NOTE' },
        idPhotoUpload: true,
        microphoneNotRequired: true,
        reason: 'SECRET-REASON',
        reasonCode: 'SECRET-CODE',
        notes: 'SECRET-NOTES',
        assistiveInput: { label: 'SECRET-ASSIST', setAt: '2026-01-01T00:00:00Z' },
        allowedAssistiveTools: ['SECRET-TOOL'],
        extraTimePct: 987654,
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { gate: Record<string, boolean> };
    expect(Object.keys(body).sort()).toEqual([
      'disabledDetectors',
      'faceDetectorsOff',
      'gate',
      'identityCheckWaived',
    ]);
    expect(Object.keys(body.gate).sort()).toEqual([
      'idPhotoUpload',
      'microphoneNotRequired',
      'roomScanAlternative',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|987654|OTHER/);
  });

  it('FR-403: a waiver and a disabled FACE detector show in the projection and nothing private', async () => {
    const res = await get({
      accommodations: {
        identityCheckWaiver: {
          reasonCode: 'REFUSED_BIOMETRIC_PROCESSING',
          reasonNote: 'SECRET-NOTE',
        },
        disabledDetectors: ['FACE'],
        extraTimePct: 25,
        allowedAssistiveTools: ['screen-reader'],
        notes: 'PRIVATE-NOTES',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...EMPTY,
      identityCheckWaived: true,
      faceDetectorsOff: true,
      disabledDetectors: ['FACE'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-NOTE|PRIVATE-NOTES|REFUSED|screen-reader/);
  });

  it('FR-305: a detector other than FACE leaves faceDetectorsOff false; the erasure marker keeps the waiver', async () => {
    const res = await get({
      accommodations: { disabledDetectors: ['GAZE'], identityCheckWaived: true },
    });
    expect(res.body).toEqual({
      ...EMPTY,
      identityCheckWaived: true,
      disabledDetectors: ['GAZE'],
    });
  });

  it('TC-008: the token binds the session; another candidate never sees the first one`s flags', async () => {
    const waived = await createInvitation(owner, tenant, {
      status: 'CONSENTED',
      accommodations: { disabledDetectors: ['FACE'] },
    });
    const plain = await createInvitation(owner, tenant, { status: 'CONSENTED' });
    const tokenPlain = tokens.sign({ sid: plain.sessionId, oid: tenant.orgId, epoch: 0 }).token;
    const res = await request(app.getHttpServer())
      .get(URL_PATH)
      .query({ sessionId: waived.sessionId })
      .set('Authorization', `Bearer ${tokenPlain}`);
    expect(res.body).toEqual(EMPTY);
  });

  it('FR-609: an expired token is 401 TOKEN_EXPIRED; no token is 401', async () => {
    const inv = await createInvitation(owner, tenant, { status: 'CONSENTED' });
    const old = tokens.sign(
      { sid: inv.sessionId, oid: tenant.orgId, epoch: 0 },
      new Date(Date.now() - 3_600_000),
    );
    const res = await request(app.getHttpServer())
      .get(URL_PATH)
      .set('Authorization', `Bearer ${old.token}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
    await request(app.getHttpServer()).get(URL_PATH).expect(401);
  });
});
