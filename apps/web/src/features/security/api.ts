import { api, type Schemas } from '@/lib/api/client';
import { refreshSession } from '@/lib/auth-session';
import { REAUTH_FAILED_CODE } from './schemas';

/*
 * Calls for the Security page. None of them may sign the user out: a wrong password is HTTP 403
 * REAUTH_FAILED and is reported to the dialog only (it is not a 401, so no refresh and no
 * redirect). The /v1/auth/* calls are skipped by the client's own 401 retry, so a 401 (access
 * token expired while the page sat open) is retried here once after a silent refresh.
 * Passwords are only passed through; nothing is logged or stored.
 */

export type Failure =
  /** Wrong current password (403 REAUTH_FAILED). */
  | 'password'
  /** Wrong first code during set-up (400). */
  | 'code'
  /** The state changed elsewhere (409), for example 2FA is already on. */
  | 'conflict'
  /** Some other 403, for example the role may not do this. */
  | 'forbidden'
  /** 401 even after a refresh. */
  | 'session'
  | 'network'
  | 'unknown';

export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

interface Result<T> {
  data?: T | undefined;
  error?: Schemas['ApiError'] | undefined;
  response: Response;
}

async function run<T>(send: () => Promise<Result<T>>, empty?: T): Promise<Outcome<T>> {
  try {
    let result = await send();
    if (result.response.status === 401 && (await refreshSession())) result = await send();
    const { response, error } = result;
    if (response.ok) {
      const data = result.data ?? empty;
      return data === undefined ? { ok: false, failure: 'unknown' } : { ok: true, data };
    }
    if (response.status === 403) {
      return { ok: false, failure: error?.code === REAUTH_FAILED_CODE ? 'password' : 'forbidden' };
    }
    if (response.status === 400) return { ok: false, failure: 'code' };
    if (response.status === 409) return { ok: false, failure: 'conflict' };
    if (response.status === 401) return { ok: false, failure: 'session' };
    return { ok: false, failure: 'unknown' };
  } catch {
    return { ok: false, failure: 'network' };
  }
}

export interface SetupStart {
  manualKey: string;
  otpauthUri: string;
}

export const fetchTwoFactorStatus = async (): Promise<boolean> => {
  const out = await run(() => api.GET('/v1/auth/2fa/status'));
  if (!out.ok) throw new Error(out.failure);
  return out.data.enabled;
};

export const startSetup = (currentPassword: string) =>
  run<SetupStart>(() => api.POST('/v1/auth/2fa/setup/start', { body: { currentPassword } }));

export const confirmSetup = (currentPassword: string, code: string) =>
  run<Schemas['RecoveryCodes']>(() =>
    api.POST('/v1/auth/2fa/setup/confirm', { body: { currentPassword, code } }),
  );

export const disableTwoFactor = (currentPassword: string) =>
  run<true>(async () => {
    const { error, response } = await api.POST('/v1/auth/2fa/disable', {
      body: { currentPassword },
    });
    return { data: undefined, error, response };
  }, true);

export const regenerateRecoveryCodes = (currentPassword: string) =>
  run<Schemas['RecoveryCodes']>(() =>
    api.POST('/v1/auth/2fa/recovery-codes/regenerate', { body: { currentPassword } }),
  );
