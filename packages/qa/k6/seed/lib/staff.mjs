// Staff session: password login, TOTP when the account has it, re-login once on a 401 (the access
// token lives 15 minutes, FR-104). The refresh cookie is not used.
import { ROUTES } from './routes.mjs';
import { totp } from './totp.mjs';
import { SeedError } from './redact.mjs';

export function createStaff({ client, credentials, expectOrgName, secrets }) {
  let accessToken = null;

  function pickSession(json) {
    const s = json?.session ?? json;
    if (!s?.accessToken)
      throw new SeedError('login: unexpected response shape.', { step: 'login' });
    return s;
  }

  async function login() {
    const first = await client.request('POST', ROUTES.login, {
      step: 'staff login',
      idempotent: false,
      body: { email: credentials.email, password: credentials.password },
    });
    let session;
    if (first.json?.status === 'authenticated') session = pickSession(first.json);
    else if (first.json?.status === 'two_factor_required') {
      if (!credentials.totpSecret) {
        throw new SeedError('staff login needs a TOTP code: set SEED_STAFF_TOTP_SECRET.', {
          step: 'staff login',
        });
      }
      secrets.push(first.json.challengeToken);
      const second = await client.request('POST', ROUTES.verify2fa, {
        step: 'staff 2fa',
        idempotent: false,
        body: { challengeToken: first.json.challengeToken, code: totp(credentials.totpSecret) },
      });
      session = pickSession(second.json);
    } else {
      throw new SeedError(
        'staff login needs a human step (2FA enrolment is required for this account).',
        { step: 'staff login' },
      );
    }
    // The synthetic-org guard: the account must belong to the organisation named in SEED_ORG_NAME.
    if (session.user?.orgName !== expectOrgName) {
      throw new SeedError('staff account does not belong to SEED_ORG_NAME; refusing to continue.', {
        step: 'staff login',
      });
    }
    accessToken = session.accessToken;
    secrets.push(accessToken);
  }

  async function call(method, path, opts = {}) {
    if (!accessToken) await login();
    try {
      return await client.request(method, path, { ...opts, token: accessToken });
    } catch (e) {
      if (e instanceof SeedError && e.status === 401) {
        await login();
        return client.request(method, path, { ...opts, token: accessToken });
      }
      throw e;
    }
  }

  return { login, call };
}
