import type { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { Env } from '../config/env';
import { AuthController, refreshCookieOptions } from './auth.controller';
import type { AuthService, SessionOutcome } from './auth.service';

// FR-101, FR-104, DL-52: the cp_refresh `secure` attribute follows the environment. It is false
// only for APP_ENV=development; every other value, and NODE_ENV=production always, stays true.

type AppEnv = Env['APP_ENV'];
type NodeEnv = Env['NODE_ENV'];

describe('refreshCookieOptions (FR-101, FR-104, DL-52)', () => {
  const table: Array<[AppEnv, NodeEnv, boolean]> = [
    ['development', 'development', false],
    ['development', 'test', false],
    ['development', 'production', true],
    ['test', 'test', true],
    ['test', 'development', true],
    ['staging', 'production', true],
    ['staging', 'development', true],
    ['pilot', 'production', true],
    ['pilot', 'development', true],
    ['production', 'production', true],
    ['production', 'development', true],
  ];

  it.each(table)('APP_ENV=%s NODE_ENV=%s -> secure %s', (APP_ENV, NODE_ENV, secure) => {
    expect(refreshCookieOptions({ APP_ENV, NODE_ENV }).secure).toBe(secure);
  });

  it('a misspelt APP_ENV keeps secure true (allowlist)', () => {
    const o = refreshCookieOptions({
      APP_ENV: 'Development' as unknown as AppEnv,
      NODE_ENV: 'development',
    });
    expect(o.secure).toBe(true);
  });

  it('every other attribute is unchanged in every environment', () => {
    for (const [APP_ENV, NODE_ENV] of table) {
      const o = refreshCookieOptions({ APP_ENV, NODE_ENV });
      expect(o).toEqual({
        httpOnly: true,
        secure: o.secure,
        sameSite: 'strict',
        signed: true,
        path: '/api/v1/auth',
      });
    }
  });
});

describe('AuthController cookie attributes (FR-101, FR-104, DL-52)', () => {
  const outcome = {
    refreshToken: 'tok',
    body: { status: 'authenticated' },
  } as unknown as SessionOutcome;

  const fakeAuth = {
    login: (): Promise<SessionOutcome> => Promise.resolve(outcome),
    logout: (): Promise<void> => Promise.resolve(),
  } as unknown as AuthService;

  function app(appEnv: AppEnv, nodeEnv: NodeEnv): express.Express {
    const values: Record<string, string> = { APP_ENV: appEnv, NODE_ENV: nodeEnv };
    const config = { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
    const controller = new AuthController(fakeAuth, config);
    const a = express();
    a.use(express.json());
    a.use(cookieParser('test-secret'));
    a.post('/login', (req: Request, res: Response, next) => {
      controller
        .login({ email: 'a@b.c', password: 'x' }, req, res)
        .then(() => res.status(200).end(), next);
    });
    a.post('/logout', (req: Request, res: Response, next) => {
      controller.logout(req, res).then(() => res.status(204).end(), next);
    });
    return a;
  }

  async function setAndClear(appEnv: AppEnv, nodeEnv: NodeEnv): Promise<[string, string]> {
    const a = app(appEnv, nodeEnv);
    const login = await request(a).post('/login').expect(200);
    const set = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cp_refresh='),
    );
    const logout = await request(a)
      .post('/logout')
      .set('Cookie', 'cp_refresh=anything')
      .expect(204);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cp_refresh=;'),
    );
    return [set ?? '', cleared ?? ''];
  }

  it('development: neither the set nor the clear carries Secure', async () => {
    const [set, cleared] = await setAndClear('development', 'development');
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\/api\/v1\/auth/);
    expect(set).not.toMatch(/Secure/);
    expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
    expect(cleared).toMatch(/SameSite=Strict/);
    expect(cleared).not.toMatch(/Secure/);
  });

  it.each([
    ['development', 'production'],
    ['test', 'test'],
    ['staging', 'production'],
    ['pilot', 'production'],
    ['production', 'production'],
  ] as Array<[AppEnv, NodeEnv]>)(
    'APP_ENV=%s NODE_ENV=%s: set and clear both carry Secure with the same path and SameSite',
    async (appEnv, nodeEnv) => {
      const [set, cleared] = await setAndClear(appEnv, nodeEnv);
      for (const c of [set, cleared]) {
        expect(c).toMatch(/; Secure/);
        expect(c).toMatch(/HttpOnly/);
        expect(c).toMatch(/SameSite=Strict/);
        expect(c).toMatch(/Path=\/api\/v1\/auth/);
      }
    },
  );
});
