// FR-301: the global default throttle (100 requests a minute per IP) covers the test builder routes.
// Booted with the DEFAULT limits on purpose (the other fr-301 files lift the limit).
import { newOrg, Org } from '../support/be06-helpers';
import { call } from '../support/be03-helpers';
import { boot, Harness } from '../support/harness';

describe('FR-301: test builder rate limit', () => {
  let h: Harness;
  let org: Org;
  beforeAll(async () => {
    h = await boot();
    org = await newOrg(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('FR-301: GET /tests answers 429 once the default limit (100 a minute per IP) is used up', async () => {
    let limitedAt = 0;
    for (let i = 1; i <= 110 && limitedAt === 0; i++) {
      const res = await call(h, 'GET', '/tests', org.recruiter.token);
      if (res.status === 429) limitedAt = i;
      else expect(res.status).toBe(200);
    }
    expect(limitedAt).toBeGreaterThan(0);
    expect(limitedAt).toBeLessThanOrEqual(101);
  });
});
