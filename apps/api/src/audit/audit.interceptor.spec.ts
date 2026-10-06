import {
  Controller,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ProblemFilter } from '../common/problem.filter';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Audited } from './audited.decorator';
import { AuditInterceptor } from './audit.interceptor';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

@Controller('probe')
class ProbeController {
  // A read of candidate data by staff (FR-105).
  @Get('sessions/:id')
  @Audited('SESSION_REVIEW_READ', 'session', { idParam: 'id' })
  read(@Param('id') id: string): { id: string; secretRecording: string } {
    if (id === 'missing') throw new NotFoundException();
    // A lock timeout raised by the handler itself, before anything committed.
    if (id === 'locked') throw Object.assign(new Error('lock wait'), { code: '55P03' });
    return { id, secretRecording: 'candidate data' };
  }

  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }
}

class FakeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    if (req.headers['x-user'] === 'yes') {
      req.user = { id: USER, orgId: ORG, role: 'REVIEWER', kind: 'access' };
    }
    return true;
  }
}

describe('AuditInterceptor (FR-105, TC-006)', () => {
  let app: INestApplication<App>;
  const created: { data: Record<string, unknown> }[] = [];
  let failWrite: Error | false = false;
  let orgSeenByWrite: string | undefined;

  beforeAll(async () => {
    const orgContext = new OrgContextService();
    const prisma = {
      client: {
        auditLog: {
          create: (args: { data: Record<string, unknown> }) => {
            orgSeenByWrite = orgContext.requireOrgId();
            if (failWrite) return Promise.reject(failWrite);
            created.push(args);
            return Promise.resolve({});
          },
        },
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: OrgContextService, useValue: orgContext },
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: FakeGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    created.length = 0;
    failWrite = false;
    orgSeenByWrite = undefined;
  });

  it('TC-006: a staff read of candidate data writes who, what, entity, IP, in the caller org', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/sessions/abc-123?token=secret-query-value')
      .set('x-user', 'yes')
      .expect(200);
    expect(res.body).toMatchObject({ id: 'abc-123' });
    expect(created).toHaveLength(1);
    const row = created[0]?.data;
    expect(row).toMatchObject({
      orgId: ORG,
      actorId: USER,
      action: 'SESSION_REVIEW_READ',
      entityType: 'session',
      entityId: 'abc-123',
    });
    expect(String(row?.ip)).toMatch(/127\.0\.0\.1/);
    expect(orgSeenByWrite).toBe(ORG);
    // No query string, token or body in the row.
    expect(row?.metadata).toEqual({ method: 'GET', route: '/probe/sessions/:id' });
    expect(JSON.stringify(row)).not.toContain('secret-query-value');
  });

  it('FR-105: a uuid entity id is stored in lowercase whatever case the URL used', async () => {
    const id = 'ABCDEF12-3456-4789-8ABC-DEF123456789';
    await request(app.getHttpServer())
      .get(`/probe/sessions/${id}`)
      .set('x-user', 'yes')
      .expect(200);
    expect(created[0]?.data.entityId).toBe(id.toLowerCase());
  });

  it('FR-105: a handler that fails (404) writes no audit row; an unmarked route writes none', async () => {
    await request(app.getHttpServer())
      .get('/probe/sessions/missing')
      .set('x-user', 'yes')
      .expect(404);
    await request(app.getHttpServer()).get('/probe/plain').set('x-user', 'yes').expect(200);
    expect(created).toHaveLength(0);
  });

  it('FR-105: when the audit write fails the read fails and the candidate data is not returned', async () => {
    failWrite = new Error('disk full');
    const res = await request(app.getHttpServer())
      .get('/probe/sessions/abc')
      .set('x-user', 'yes')
      .expect(500);
    expect(JSON.stringify(res.body)).not.toContain('candidate data');
  });

  it('FR-105: an audited route without a verified user is refused rather than logged anonymously', async () => {
    const res = await request(app.getHttpServer()).get('/probe/sessions/abc').expect(500);
    expect(JSON.stringify(res.body)).not.toContain('candidate data');
    expect(created).toHaveLength(0);
  });

  // No TC id covers DL-37 in docs/test-cases.md; FR-105 and the decision id name these.
  it('DL-37, FR-105: a lock error from the post-handler audit write is a fixed 500 with no Retry-After and no data', async () => {
    failWrite = Object.assign(new Error('lock wait'), { code: '55P03' });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app.getHttpServer())
        .get('/probe/sessions/abc')
        .set('x-user', 'yes')
        .expect(500);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('candidate data');
      expect(JSON.stringify(error.mock.calls)).not.toContain('lock wait');
    } finally {
      error.mockRestore();
    }
  });

  it('DL-37: the same lock error from the handler itself is 503 with Retry-After', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const res = await request(app.getHttpServer())
        .get('/probe/sessions/locked')
        .set('x-user', 'yes')
        .expect(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(created).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
