import { HttpJudge0Client } from './http-judge0.client';
import { Judge0UnavailableError } from './judge0.types';
import type { Judge0Submission } from './judge0.types';

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const tok = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sub = (code = 'print(1)', wallMs = 5000): Judge0Submission => ({
  languageId: 100,
  sourceCode: code,
  stdin: 'in',
  limits: { cpuMs: 2000, wallMs, memoryKb: 262144 },
  maxOutputBytes: 1024,
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  url: string;
  init: RequestInit;
}

const finished = (stdout: string, extra: Record<string, unknown> = {}) => ({
  status: { id: 3 },
  stdout: b64(stdout),
  stderr: null,
  compile_output: null,
  message: null,
  time: '0.012',
  wall_time: '0.02',
  memory: 3000,
  exit_code: 0,
  ...extra,
});
const pending = { status: { id: 2 } };

/**
 * Scripted fake of the Judge0 HTTP API. POST creates tokens; GET returns the next scripted poll
 * (the last one repeats); DELETE is recorded.
 */
function harness(opts: {
  polls: unknown[][];
  postStatus?: number;
  deleteStatus?: number;
  deleteThrows?: boolean;
  postBody?: unknown;
  pollDeadlineMs?: number;
  maxBatchSize?: number;
}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let t = 0;
  let nextToken = 1;
  let pollIndex = 0;
  const fetchFn = ((url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    if (method === 'POST') {
      if (opts.postStatus && opts.postStatus >= 400)
        return Promise.resolve(json({}, opts.postStatus));
      if (opts.postBody !== undefined) return Promise.resolve(json(opts.postBody));
      const n = (JSON.parse(init.body as string) as { submissions: unknown[] }).submissions.length;
      return Promise.resolve(json(Array.from({ length: n }, () => ({ token: tok(nextToken++) }))));
    }
    if (method === 'DELETE') {
      if (opts.deleteThrows) return Promise.reject(new Error('boom http://secret-host'));
      return Promise.resolve(json({ token: 'x' }, opts.deleteStatus ?? 200));
    }
    const list = opts.polls[Math.min(pollIndex, opts.polls.length - 1)] ?? [];
    pollIndex += 1;
    return Promise.resolve(json({ submissions: list }));
  }) as unknown as typeof fetch;
  const client = new HttpJudge0Client({
    baseUrl: 'http://judge0.internal:2358/',
    authToken: 'tok-123',
    requestTimeoutMs: 1000,
    pollDeadlineMs: opts.pollDeadlineMs ?? 5000,
    maxBatchSize: opts.maxBatchSize ?? 2,
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    now: () => t,
  });
  const deletes = () => calls.filter((c) => c.method === 'DELETE');
  return { client, calls, sleeps, deletes };
}

describe('HttpJudge0Client (FR-503)', () => {
  it('FR-503: submits base64 with limits in seconds, no network, auth header, and decodes output', async () => {
    const h = harness({ polls: [[finished('hello\n')]] });
    const [result] = await h.client.runBatch([sub()]);
    expect(result?.stdout).toBe('hello\n');
    expect(result?.timeMs).toBe(12);
    expect(result?.memoryKb).toBe(3000);
    const post = h.calls[0] as Call;
    expect(post.url).toBe('http://judge0.internal:2358/submissions/batch?base64_encoded=true');
    expect((post.init.headers as Record<string, string>)['X-Auth-Token']).toBe('tok-123');
    const body = JSON.parse(post.init.body as string) as { submissions: Record<string, unknown>[] };
    expect(body.submissions[0]).toMatchObject({
      language_id: 100,
      source_code: b64('print(1)'),
      stdin: b64('in'),
      cpu_time_limit: 2,
      wall_time_limit: 5,
      memory_limit: 262144,
      enable_network: false,
    });
  });

  it('FR-503: sends the auth header on poll and delete too', async () => {
    const h = harness({ polls: [[finished('x')]] });
    await h.client.runBatch([sub()]);
    expect(h.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE']);
    for (const c of h.calls) {
      expect((c.init.headers as Record<string, string>)['X-Auth-Token']).toBe('tok-123');
    }
  });

  it('FR-503: polls with growing backoff until every submission finished', async () => {
    const h = harness({ polls: [[pending], [pending], [finished('ok')]] });
    await h.client.runBatch([sub()]);
    expect(h.sleeps).toEqual([200, 300]);
  });

  it('FR-503: splits into batches of maxBatchSize and keeps order', async () => {
    const h = harness({ polls: [[finished('1'), finished('2')], [finished('3')]] });
    const out = await h.client.runBatch([sub(), sub(), sub()]);
    expect(out.map((r) => r.stdout)).toEqual(['1', '2', '3']);
  });

  it('FR-503: caps decoded output at maxOutputBytes', async () => {
    const h = harness({ polls: [[finished('x'.repeat(5000))]] });
    const [r] = await h.client.runBatch([sub()]);
    expect(r?.stdout).toHaveLength(1024);
  });

  it('FR-503: strips newline-wrapped base64 before slicing', async () => {
    const wrapped = (b64('y'.repeat(900)).match(/.{1,60}/g) ?? []).join('\n') + '\n';
    const h = harness({ polls: [[{ ...finished('z'), stdout: wrapped }]] });
    const [r] = await h.client.runBatch([sub()]);
    expect(r?.stdout).toBe('y'.repeat(900));
  });

  it('FR-503: deletes every submission after results are fetched', async () => {
    const h = harness({ polls: [[finished('1'), finished('2')]] });
    await h.client.runBatch([sub(), sub()]);
    expect(h.deletes().map((c) => c.url)).toEqual([
      `http://judge0.internal:2358/submissions/${tok(1)}?fields=token`,
      `http://judge0.internal:2358/submissions/${tok(2)}?fields=token`,
    ]);
  });

  it('FR-503: deletes submissions on timeout and still reports it as unavailable', async () => {
    const h = harness({ polls: [[pending]], pollDeadlineMs: 1000 });
    await expect(h.client.runBatch([sub('x', 1000)])).rejects.toThrow(Judge0UnavailableError);
    expect(h.deletes()).toHaveLength(1);
  });

  it('FR-503: deletes submissions when polling fails', async () => {
    const h = harness({ polls: [[]] });
    await expect(h.client.runBatch([sub()])).rejects.toThrow(Judge0UnavailableError);
    expect(h.deletes()).toHaveLength(1);
  });

  it('FR-503: a failing or erroring DELETE never throws and results still return', async () => {
    const a = harness({ polls: [[finished('ok')]], deleteStatus: 404 });
    expect((await a.client.runBatch([sub()]))[0]?.stdout).toBe('ok');
    const b = harness({ polls: [[finished('ok')]], deleteThrows: true });
    expect((await b.client.runBatch([sub()]))[0]?.stdout).toBe('ok');
  });

  it('FR-503: one deadline covers the whole batch, not one per chunk', async () => {
    // 3 chunks of 1 that never finish: total sleeping must stay within one shared budget.
    const h = harness({ polls: [[pending]], pollDeadlineMs: 1000, maxBatchSize: 1 });
    await expect(
      h.client.runBatch([sub('x', 1000), sub('x', 1000), sub('x', 1000)]),
    ).rejects.toThrow(Judge0UnavailableError);
    const budget = 1000 + Math.ceil(3 / 2) * 1000;
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget);
    // The first chunk timed out, so later chunks were never submitted.
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('FR-503: rejects tokens that are not UUIDs (and deletes none of them)', async () => {
    const h = harness({ polls: [[finished('x')]], postBody: [{ token: '../../etc' }] });
    await expect(h.client.runBatch([sub()])).rejects.toThrow(Judge0UnavailableError);
    expect(h.deletes()).toHaveLength(0);
    expect(h.calls.some((c) => c.method === 'GET')).toBe(false);
  });

  it('FR-503: a POST count mismatch is an unexpected response', async () => {
    const h = harness({ polls: [[]], postBody: [{ token: tok(1) }, { token: tok(2) }] });
    await expect(h.client.runBatch([sub()])).rejects.toThrow(Judge0UnavailableError);
    expect(h.deletes()).toHaveLength(2);
  });

  it('FR-503: HTTP 5xx on submit is unavailable without leaking details', async () => {
    const h = harness({ polls: [[]], postStatus: 503 });
    const err = await h.client.runBatch([sub()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Judge0UnavailableError);
    expect(String((err as Error).message)).not.toMatch(/judge0\.internal|tok-123/);
  });

  it('FR-503: network failure becomes Judge0UnavailableError without echoing the error', async () => {
    const client = new HttpJudge0Client({
      baseUrl: 'http://judge0.internal:2358',
      authToken: 'tok-123',
      requestTimeoutMs: 1000,
      pollDeadlineMs: 1000,
      fetchFn: () =>
        Promise.reject(new Error('boom http://secret-host')),
    });
    const err = await client.runBatch([sub()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Judge0UnavailableError);
    expect(String((err as Error).message)).not.toMatch(/secret-host|tok-123/);
  });

  it('FR-503: an empty batch makes no requests', async () => {
    const h = harness({ polls: [[]] });
    expect(await h.client.runBatch([])).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});
