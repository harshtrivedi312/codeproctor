import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import { TokenService } from '../common/auth/token.service';
import {
  CANDIDATE_AUDIENCE,
  CANDIDATE_ISSUER,
  CandidateTokenError,
  CandidateTokenService,
} from './candidate-token.service';

const CANDIDATE_SECRET = randomBytes(32).toString('base64');
const STAFF_SECRET = randomBytes(32).toString('base64');

function config(values: Record<string, unknown>): ConfigService<Env, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

const claims = () => ({ sid: randomUUID(), oid: randomUUID(), epoch: 2 });

describe('Candidate JWT (ADR 0013 section 5.10, CS-1)', () => {
  const service = new CandidateTokenService(
    config({ JWT_CANDIDATE_SECRET: CANDIDATE_SECRET, CANDIDATE_TOKEN_TTL_SECONDS: 900 }),
  );

  function reason(token: string): string {
    try {
      service.verify(token);
      return 'accepted';
    } catch (e) {
      return e instanceof CandidateTokenError ? e.reason : `other:${String(e)}`;
    }
  }

  it('FR-106: a signed token round-trips sid, oid and epoch and expires after the configured lifetime', () => {
    const c = claims();
    const now = new Date('2026-10-05T10:00:00.000Z');
    const issued = service.sign(c, now);
    expect(issued.expiresAt.getTime()).toBe(now.getTime() + 900_000);
    const verified = jwt.decode(issued.token) as Record<string, unknown>;
    expect(verified.typ).toBe('candidate');
    expect(verified.iss).toBe(CANDIDATE_ISSUER);
    expect(verified.aud).toBe(CANDIDATE_AUDIENCE);
    // Verify with the real clock: use a token issued now.
    const fresh = service.sign(c);
    expect(service.verify(fresh.token)).toMatchObject({ sid: c.sid, oid: c.oid, epoch: 2 });
  });

  it('FR-106, NFR-04: a staff token (staff secret, staff claims) is refused as a candidate token', () => {
    const staff = new TokenService(config({ JWT_ACCESS_SECRET: STAFF_SECRET }));
    const token = staff.sign({ sub: randomUUID(), org: randomUUID(), role: 'RECRUITER', kind: 'access' }, 300);
    expect(reason(token)).toBe('invalid');
  });

  it('NFR-04: the staff secret cannot sign a candidate token even with candidate claims', () => {
    const forged = jwt.sign(
      { typ: 'candidate', ...claims() },
      STAFF_SECRET,
      { algorithm: 'HS256', expiresIn: 300, issuer: CANDIDATE_ISSUER, audience: CANDIDATE_AUDIENCE },
    );
    expect(reason(forged)).toBe('invalid');
  });

  it('NFR-04: alg none, other algorithms, wrong issuer, wrong audience and wrong typ are refused', () => {
    const c = claims();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ typ: 'candidate', ...c, iss: CANDIDATE_ISSUER, aud: CANDIDATE_AUDIENCE, exp: 9999999999 }),
    ).toString('base64url')}.`;
    expect(reason(none)).toBe('invalid');
    const hs512 = jwt.sign({ typ: 'candidate', ...c }, CANDIDATE_SECRET, {
      algorithm: 'HS512',
      expiresIn: 300,
      issuer: CANDIDATE_ISSUER,
      audience: CANDIDATE_AUDIENCE,
    });
    expect(reason(hs512)).toBe('invalid');
    const sign = (payload: object, options: jwt.SignOptions): string =>
      jwt.sign(payload, CANDIDATE_SECRET, { algorithm: 'HS256', expiresIn: 300, ...options });
    expect(reason(sign({ typ: 'candidate', ...c }, { issuer: 'someone', audience: CANDIDATE_AUDIENCE }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', ...c }, { issuer: CANDIDATE_ISSUER, audience: 'codeproctor-staff' }))).toBe('invalid');
    expect(reason(sign({ typ: 'staff', ...c }, { issuer: CANDIDATE_ISSUER, audience: CANDIDATE_AUDIENCE }))).toBe('invalid');
  });

  it('NFR-04: missing or malformed claims are refused', () => {
    const base = { issuer: CANDIDATE_ISSUER, audience: CANDIDATE_AUDIENCE };
    const sign = (payload: object): string =>
      jwt.sign(payload, CANDIDATE_SECRET, { algorithm: 'HS256', expiresIn: 300, ...base });
    const c = claims();
    expect(reason(sign({ typ: 'candidate', oid: c.oid, epoch: 1 }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', sid: 'not-a-uuid', oid: c.oid, epoch: 1 }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', sid: c.sid, oid: c.oid }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', sid: c.sid, oid: c.oid, epoch: -1 }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', sid: c.sid, oid: c.oid, epoch: '1' }))).toBe('invalid');
    expect(reason(sign({ typ: 'candidate', sid: c.sid, oid: c.oid, epoch: 1.5 }))).toBe('invalid');
    expect(reason('not.a.jwt')).toBe('invalid');
    expect(reason('')).toBe('invalid');
  });

  it('FR-609: an expired token is reported as expired, not as invalid (TOKEN_EXPIRED)', () => {
    const c = claims();
    const old = service.sign(c, new Date(Date.now() - 3_600_000));
    expect(reason(old.token)).toBe('expired');
  });

  it('NFR-04: without JWT_CANDIDATE_SECRET the portal answers 503 CANDIDATE_PORTAL_UNCONFIGURED', () => {
    const bare = new CandidateTokenService(config({ CANDIDATE_TOKEN_TTL_SECONDS: 900 }));
    try {
      bare.sign(claims());
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodedHttpException);
      expect((e as CodedHttpException).getStatus()).toBe(503);
      expect((e as CodedHttpException).code).toBe('CANDIDATE_PORTAL_UNCONFIGURED');
    }
    expect(() => bare.verify('x.y.z')).toThrow(CodedHttpException);
  });
});
