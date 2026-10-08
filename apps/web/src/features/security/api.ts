import { api, type Schemas } from '@/lib/api/client';
import { captureSessionStamp, refreshForReplay } from '@/lib/auth-session';
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
  /** 400: wrong first code during set-up, or a missing or invalid field. */
  | 'code'
  /** The state changed elsewhere (409), for example 2FA is already on. */
  | 'conflict'
  /** Some other 403. */
  | 'forbidden'
  /** 401 even after a refresh. */
  | 'session'
  /** 503: try again in a moment (nothing was counted). */
  | 'busy'
  | 'network'
  | 'unknown';

export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

interface Result<T> {
  data?: T | undefined;
  error?: Schemas['ProblemDetails'] | Schemas['ApiError'] | undefined;
  response: Response;
}

async function run<T>(send: () => Promise<Result<T>>, empty?: T): Promise<Outcome<T>> {
  try {
    const stamp = captureSessionStamp();
    let result = await send();
    if (result.response.status === 401) {
      // Replay only for the same signed-in user; never send this password as someone else.
      if (!(await refreshForReplay(stamp))) return { ok: false, failure: 'session' };
      result = await send();
    }
    const { response, error } = result;
    if (response.ok) {
      const data = result.data ?? empty;
      return data === undefined ? { ok: false, failure: 'unknown' } : { ok: true, data };
    }
    if (response.status === 403) {
      return {
        ok: false,
        failure: error?.code === REAUTH_FAILED_CODE ? 'password' : 'forbidden',
      };
    }
    if (response.status === 400) return { ok: false, failure: 'code' };
    if (response.status === 409) return { ok: false, failure: 'conflict' };
    if (response.status === 401) return { ok: false, failure: 'session' };
    if (response.status === 503) return { ok: false, failure: 'busy' };
    return { ok: false, failure: 'unknown' };
  } catch {
    return { ok: false, failure: 'network' };
  }
}

export interface SetupStart {
  manualKey: string;
  otpauthUri: string;
  /** QR code as a PNG data URL, made by the server. */
  qrDataUrl: string;
}

export const startSetup = (currentPassword: string) =>
  run<SetupStart>(() => api.POST('/v1/auth/2fa/setup/start', { body: { currentPassword } }));

export const confirmSetup = (currentPassword: string, code: string) =>
  run<Schemas['RecoveryCodes']>(() =>
    api.POST('/v1/auth/2fa/setup/confirm', { body: { currentPassword, code } }),
  );

export const disableTwoFactor = (currentPassword: string, totpCode: string) =>
  run<true>(async () => {
    const { error, response } = await api.POST('/v1/auth/2fa/disable', {
      body: { currentPassword, totpCode: totpCode.trim() },
    });
    return { data: undefined, error, response };
  }, true);

export const regenerateRecoveryCodes = (currentPassword: string) =>
  run<Schemas['RecoveryCodes']>(() =>
    api.POST('/v1/auth/2fa/recovery-codes/regenerate', { body: { currentPassword } }),
  );
