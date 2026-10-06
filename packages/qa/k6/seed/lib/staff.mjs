// Staff session: password login, TOTP when the account has it, re-login once on a 401 (the access
// token lives 15 minutes, FR-104). The refresh cookie is not used.
import { ROUTES } from './routes.mjs';
import { totp } from './totp.mjs';
import { SeedError } from './redact.mjs';

export function createStaff({
  client,
  credentials,
  expectOrgName,
  secrets,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  let accessToken = null;
  let flight = null; // single-flight login: concurrent 401s share one login
  let lastStep = -1; // TOTP time step already used: the API refuses a replay (FU-BE-20)

  function pickSession(json) {
    const s = json?.session ?? json;
    if (!s?.accessToken)
      throw new SeedError('login: unexpected response shape.', { step: 'login' });
    return s;
  }

  async function doLogin() {
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
      // Never reuse a time step: wait for the next one (its code is computed for that instant).
      let at = now();
      if (Math.floor(at / 30000) <= lastStep) {
        const wait = (lastStep + 1) * 30000 - at;
        await sleep(wait);
        at += wait;
      }
      lastStep = Math.floor(at / 30000);
      const second = await client.request('POST', ROUTES.verify2fa, {
        step: 'staff 2fa',
        idempotent: false,
        body: { challengeToken: first.json.challengeToken, code: totp(credentials.totpSecret, at) },
      });
      session = pickSession(second.json);
    } else if (first.json?.status === 'two_factor_enrollment_required') {
      throw new SeedError(
        'staff login needs a human step (2FA enrolment is required for this account).',
        { step: 'staff login' },
      );
    } else {
      throw new SeedError('staff login: unexpected response.', { step: 'staff login' });
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

  function login() {
    flight ??= doLogin().finally(() => {
      flight = null;
    });
    return flight;
  }

  async function call(method, path, opts = {}) {
    if (!accessToken) await login();
    const used = accessToken;
    try {
      return await client.request(method, path, { ...opts, token: used });
    } catch (e) {
      if (e instanceof SeedError && e.status === 401) {
        if (accessToken === used) await login(); // else another caller already re-logged in
        return client.request(method, path, { ...opts, token: accessToken });
      }
      throw e;
    }
  }

  return { login, call };
}
