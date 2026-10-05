import { http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';

/*
 * Mock staff auth API (FR-101, FR-102, FR-104, FR-107). Fake users and fake codes only.
 * The mock server keeps a little state (failed logins, enrolled users, used reset tokens, "refresh
 * cookie") so flows behave like the real thing across page reloads. In the browser that state
 * lives in one mock-only cookie; in Vitest it lives in the same cookie of jsdom. It is never real
 * credentials, and nothing here is bundled unless mocking is enabled.
 */

export const MOCK_USERS = {
  recruiter: {
    email: 'recruiter@example.test',
    password: 'Recruiter-Pass-1',
    name: 'Riley Recruiter',
    role: 'RECRUITER',
    totp: false,
  },
  admin: {
    email: 'admin@example.test',
    password: 'Admin-Pass-12345',
    name: 'Alex Admin',
    role: 'SUPER_ADMIN',
    totp: true,
  },
  author: {
    email: 'author@example.test',
    password: 'Author-Pass-12345',
    name: 'Avery Author',
    role: 'AUTHOR',
    totp: false,
  },
  reviewer: {
    email: 'reviewer@example.test',
    password: 'Reviewer-Pass-12',
    name: 'Robin Reviewer',
    role: 'REVIEWER',
    // Not enrolled yet: first login forces enrollment (TC-003).
    totp: false,
  },
} as const satisfies Record<string, MockUser>;

interface MockUser {
  email: string;
  password: string;
  name: string;
  role: Schemas['StaffRole'];
  totp: boolean;
}

/** Any six digits except the value below are rejected. */
export const MOCK_TOTP_CODE = '123456';
/** One recovery code that works once for the admin; enrollment issues the codes in MOCK_RECOVERY_CODES. */
export const MOCK_ADMIN_RECOVERY_CODE = 'ABCDEFGH23456723';
export const MOCK_RECOVERY_CODES = [
  'KJ4HG7ABCD23XY56',
  'MN2PQ3RSTU45VW67',
  'ABCD2345EFGH6723',
  'QRST5674UVWX2345',
  'ZZ22YY33XX44WW55',
  'LM6NO7PQ2RS3TU45',
  'GH5IJ6KL7MN2OP34',
  'BC3DE4FG5HI6JK72',
  'XY7ZA2BC3DE4FG56',
  'PQ2RS3TU4VW5XY67',
];
export const MOCK_RESET_TOKEN = 'mock-reset-token';
export const MOCK_INVITE_TOKEN = 'mock-invite-token';
export const MOCK_EXPIRED_TOKEN = 'mock-expired-token';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60 * 1000;

interface MockAuthState {
  failed: Record<string, number>;
  lockExpiresAt: Record<string, number>;
  enrolled: string[];
  usedRecovery: string[];
  usedTokens: string[];
  refreshFor: string | null;
}

const EMPTY: MockAuthState = {
  failed: {},
  lockExpiresAt: {},
  enrolled: [],
  usedRecovery: [],
  usedTokens: [],
  refreshFor: null,
};
const COOKIE = 'mock_auth_state';
let memory: MockAuthState = structuredClone(EMPTY);

function load(): MockAuthState {
  if (typeof document === 'undefined') return memory;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return structuredClone(EMPTY);
  try {
    return {
      ...EMPTY,
      ...(JSON.parse(decodeURIComponent(match.slice(COOKIE.length + 1))) as object),
    };
  } catch {
    return structuredClone(EMPTY);
  }
}
function save(state: MockAuthState): void {
  if (typeof document === 'undefined') memory = state;
  else
    document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(state))}; path=/; SameSite=Lax`;
}
export function resetMockAuthState(): void {
  memory = structuredClone(EMPTY);
  if (typeof document !== 'undefined') {
    document.cookie = `${COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

function findUser(email: string): MockUser | undefined {
  const lower = email.trim().toLowerCase();
  return Object.values<MockUser>(MOCK_USERS).find((u) => u.email === lower);
}
/** The role is part of the fake token so the mock admin API can answer 403 like the real one (FR-103). */
export function mockRoleFromToken(authorization: string | null): Schemas['StaffRole'] | null {
  const match = /^Bearer mock-access-([A-Z_]+)-/.exec(authorization ?? '');
  const role = match?.[1];
  return role === 'SUPER_ADMIN' || role === 'RECRUITER' || role === 'AUTHOR' || role === 'REVIEWER'
    ? role
    : null;
}

/** Plants the mock refresh cookie so the next silent refresh signs this user in (tests and demos). */
export function seedMockRefresh(email: string): void {
  const state = load();
  state.refreshFor = email;
  save(state);
}

function sessionFor(user: MockUser): Schemas['AuthSession'] {
  return {
    accessToken: `mock-access-${user.role}-${Math.random().toString(36).slice(2)}`,
    user: {
      id: `user-${user.role.toLowerCase()}`,
      email: user.email,
      name: user.name,
      role: user.role,
      orgName: 'Acme Hiring (demo)',
    },
  };
}
function userFromChallenge(token: string): MockUser | undefined {
  return token.startsWith('mock-challenge-')
    ? findUser(token.slice('mock-challenge-'.length))
    : undefined;
}
const expired = () =>
  HttpResponse.json(
    { code: 'challenge_expired', message: 'Your sign-in step expired. Sign in again.' },
    { status: 401 },
  );

export function createAuthHandlers() {
  const base = `${apiBaseUrl}/v1/auth`;
  return [
    http.post(`${base}/login`, async ({ request }) => {
      const body = (await request.json()) as { email: string; password: string };
      const state = load();
      const user = findUser(body.email);
      const key = body.email.trim().toLowerCase();
      const lockExpiresAt = state.lockExpiresAt[key] ?? 0;
      // Locked accounts refuse even the correct password (TC-002). The answer is the same generic
      // 401 as a wrong password: the API never says an account is locked (FU-BE-22).
      const locked = lockExpiresAt > Date.now();
      if (locked || !user || user.password !== body.password) {
        // Unknown emails get the same answer and are not counted, so nothing is revealed.
        if (user && !locked) {
          state.failed[key] = (state.failed[key] ?? 0) + 1;
          if (state.failed[key] >= MAX_FAILED_LOGINS) {
            state.failed[key] = 0;
            state.lockExpiresAt[key] = Date.now() + LOCK_MS;
          }
          save(state);
        }
        return HttpResponse.json(
          { code: 'invalid_credentials', message: 'Sign-in failed.' },
          { status: 401 },
        );
      }
      state.failed[key] = 0;
      const challengeToken = `mock-challenge-${user.email}`;
      if (user.role === 'SUPER_ADMIN' || user.role === 'REVIEWER') {
        const enrolled = user.totp || state.enrolled.includes(user.email);
        save(state);
        return HttpResponse.json({
          status: enrolled
            ? ('two_factor_required' as const)
            : ('two_factor_enrollment_required' as const),
          challengeToken,
        });
      }
      state.refreshFor = user.email;
      save(state);
      return HttpResponse.json({ status: 'authenticated' as const, session: sessionFor(user) });
    }),

    http.post(`${base}/2fa/enroll/start`, async ({ request }) => {
      const { challengeToken } = (await request.json()) as { challengeToken: string };
      if (!userFromChallenge(challengeToken)) return expired();
      return HttpResponse.json({
        manualKey: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUri:
          'otpauth://totp/CodeProctor:reviewer%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=CodeProctor',
      });
    }),

    http.post(`${base}/2fa/enroll/confirm`, async ({ request }) => {
      const body = (await request.json()) as { challengeToken: string; code: string };
      const user = userFromChallenge(body.challengeToken);
      if (!user) return expired();
      if (body.code !== MOCK_TOTP_CODE) {
        return HttpResponse.json(
          { code: 'invalid_code', message: 'That code did not match.' },
          { status: 400 },
        );
      }
      const state = load();
      state.enrolled.push(user.email);
      state.refreshFor = user.email;
      save(state);
      return HttpResponse.json({ session: sessionFor(user), recoveryCodes: MOCK_RECOVERY_CODES });
    }),

    http.post(`${base}/2fa/verify`, async ({ request }) => {
      const body = (await request.json()) as { challengeToken: string; code: string };
      const user = userFromChallenge(body.challengeToken);
      if (!user) return expired();
      const state = load();
      const recovery = body.code.replace(/[\s-]/g, '').toUpperCase();
      const knownRecovery =
        user.role === 'SUPER_ADMIN'
          ? [MOCK_ADMIN_RECOVERY_CODE, ...MOCK_RECOVERY_CODES]
          : MOCK_RECOVERY_CODES;
      const recoveryOk = knownRecovery.includes(recovery) && !state.usedRecovery.includes(recovery);
      if (body.code.trim() !== MOCK_TOTP_CODE && !recoveryOk) {
        return HttpResponse.json(
          { code: 'invalid_code', message: 'That code did not work.' },
          { status: 400 },
        );
      }
      if (recoveryOk) state.usedRecovery.push(recovery);
      state.refreshFor = user.email;
      save(state);
      return HttpResponse.json(sessionFor(user));
    }),

    http.post(`${base}/refresh`, () => {
      const email = load().refreshFor;
      const user = email ? findUser(email) : undefined;
      if (!user) {
        return HttpResponse.json(
          { code: 'unauthenticated', message: 'Sign in again.' },
          { status: 401 },
        );
      }
      return HttpResponse.json(sessionFor(user));
    }),

    http.post(`${base}/logout`, () => {
      const state = load();
      state.refreshFor = null;
      save(state);
      return new HttpResponse(null, { status: 204 });
    }),

    // Same answer whatever the email (FR-107, TC-098).
    http.post(`${base}/password/forgot`, () =>
      HttpResponse.json(
        { message: 'If an account exists, a reset link has been sent.' },
        { status: 202 },
      ),
    ),

    http.post(`${base}/password/reset`, async ({ request }) => {
      const body = (await request.json()) as { token: string; newPassword: string };
      const state = load();
      const valid =
        (body.token === MOCK_RESET_TOKEN || body.token === MOCK_INVITE_TOKEN) &&
        !state.usedTokens.includes(body.token);
      if (!valid) {
        // One message for unknown, expired and already-used tokens.
        return HttpResponse.json(
          { code: 'invalid_token', message: 'This link has expired or was already used.' },
          { status: 400 },
        );
      }
      state.usedTokens.push(body.token);
      // A reset revokes refresh tokens, clears the lockout and never signs in (D-22).
      state.refreshFor = null;
      state.lockExpiresAt = {};
      state.failed = {};
      save(state);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
