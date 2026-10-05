// Every /candidate route is either one of the three pre-token routes or sits behind
// CandidateSessionGuard (ADR 0013 section 5.10). The global staff guard is deny by default, and a
// candidate route must opt out of it with @Public(), so the risk is a route that is @Public() and
// has no candidate guard: it would be open to the internet. This test scans every controller under
// src (so a controller added by BE-09, BE-10 or BE-11 is checked too) and fails for such a route.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC } from '../common/auth/decorators';
import { CandidateSessionGuard } from './candidate-session.guard';

const SRC = resolve(__dirname, '..');
/** Routes that run before a session token exists (link resolve, OTP send, OTP verify). */
const PRE_TOKEN = new Set(['POST candidate/session/link', 'POST candidate/session/otp', 'POST candidate/session/start']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD'];

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'generated' ? [] : controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

interface Route {
  readonly label: string;
  readonly guarded: boolean;
  readonly isPublic: boolean;
}

function routesOf(): Route[] {
  const out: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    const exported = jest.requireActual<Record<string, unknown>>(file);
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      const base = Reflect.getMetadata(PATH_METADATA, value) as string | string[] | undefined;
      if (base === undefined) continue;
      const prefix = Array.isArray(base) ? (base[0] ?? '') : base;
      if (!`/${prefix}`.startsWith('/candidate')) continue;
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, value) as unknown[] | undefined) ?? [];
      const classPublic = Reflect.getMetadata(IS_PUBLIC, value) === true;
      for (const name of Object.getOwnPropertyNames(value.prototype as object)) {
        const handler = (value.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (verb === undefined) continue;
        const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
        const guards = [
          ...classGuards,
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
        ];
        out.push({
          label: `${METHODS[verb] ?? String(verb)} ${[prefix, path === '/' ? '' : path].filter(Boolean).join('/')}`,
          guarded: guards.includes(CandidateSessionGuard),
          isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true,
        });
      }
    }
  }
  return out;
}

describe('Candidate routes are guarded (ADR 0013 section 5.10, FR-106, NFR-04)', () => {
  const routes = routesOf();

  it('FR-106: the scan finds the candidate routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    for (const label of PRE_TOKEN) expect(routes.map((r) => r.label)).toContain(label);
  });

  it('NFR-04: every /candidate route except the three pre-token ones uses CandidateSessionGuard', () => {
    const unguarded = routes.filter((r) => !r.guarded && !PRE_TOKEN.has(r.label)).map((r) => r.label);
    expect(unguarded).toEqual([]);
  });

  it('NFR-04: the pre-token routes are exactly the allow-listed three, and public to the staff guard', () => {
    const pre = routes.filter((r) => !r.guarded);
    expect(pre.map((r) => r.label).sort()).toEqual([...PRE_TOKEN].sort());
    for (const r of pre) expect(r.isPublic).toBe(true);
  });

  it('NFR-04: no candidate route takes a :sessionId path parameter (CS-1)', () => {
    for (const r of routes) expect(r.label).not.toMatch(/:session/i);
  });
});
