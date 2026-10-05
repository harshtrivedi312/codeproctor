import { HttpJudge0Client } from './http-judge0.client';
import { Judge0UnavailableError } from './judge0.types';
import type { Judge0Submission } from './judge0.types';

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const sub = (code = 'print(1)'): Judge0Submission => ({
  languageId: 100,
  sourceCode: code,
  stdin: 'in',
  limits: { cpuMs: 2000, wallMs: 5000, memoryKb: 262144 },
  maxOutputBytes: 1024,
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

function harness(responses: Response[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let t = 0;
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('boom http://secret-host'));
  }) as unknown as typeof fetch;
  const client = new HttpJudge0Client({
    baseUrl: 'http://judge0.internal:2358/',
    authToken: 'tok-123',
    requestTimeoutMs: 1000,
    pollDeadlineMs: 5000,
    maxBatchSize: 2,
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    now: () => t,
  });
  return { client, calls, sleeps };
}

const finished = (stdout: string) => ({
  token: 'x',
  status: { id: 3 },
  stdout: b64(stdout),
  stderr: null,
  compile_output: null,
  message: null,
  time: '0.012',
  wall_time: '0.02',
  memory: 3000,
  exit_code: 0,
});

describe('HttpJudge0Client (FR-503)', () => {
  it('FR-503: submits base64 with limits in seconds, no network, auth header, and decodes output', async () => {
    const h = harness([json([{ token: 'a' }]), json({ submissions: [finished('hello\n')] })]);
    const [result] = await h.client.runBatch([sub()]);
    expect(result?.stdout).toBe('hello\n');
    expect(result?.timeMs).toBe(12);
    expect(result?.memoryKb).toBe(3000);
    const post = h.calls[0] as Call;
    expect(post.url).toBe('http://judge0.internal:2358/submissions/batch?base64_encoded=true');
    expect((post.init.headers as Record<string, string>)['X-Auth-Token']).toBe('tok-123');
    const body = JSON.parse(post.init.body as string) as {
      submissions: Record<string, unknown>[];
    };
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

  it('FR-503: polls with growing backoff until every submission finished', async () => {
    const pending = { token: 'a', status: { id: 2 } };
    const h = harness([
      json([{ token: 'a' }]),
      json({ submissions: [pending] }),
      json({ submissions: [pending] }),
      json({ submissions: [finished('ok')] }),
    ]);
    await h.client.runBatch([sub()]);
    expect(h.sleeps).toEqual([200, 300]);
  });

  it('FR-503: splits into batches of maxBatchSize and keeps order', async () => {
    const h = harness([
      json([{ token: 'a' }, { token: 'b' }]),
      json({ submissions: [finished('1'), finished('2')] }),
      json([{ token: 'c' }]),
      json({ submissions: [finished('3')] }),
    ]);
    const out = await h.client.runBatch([sub(), sub(), sub()]);
    expect(out.map((r) => r.stdout)).toEqual(['1', '2', '3']);
  });

  it('FR-503: caps decoded output at maxOutputBytes', async () => {
    const h = harness([
      json([{ token: 'a' }]),
      json({ submissions: [finished('x'.repeat(5000))] }),
    ]);
    const [r] = await h.client.runBatch([sub()]);
    expect(r?.stdout).toHaveLength(1024);
  });

  it('FR-503: times out with a generic error that does not echo the URL or token', async () => {
    const pending = { token: 'a', status: { id: 1 } };
    const h = harness([
      json([{ token: 'a' }]),
      ...Array.from({ length: 30 }, () => json({ submissions: [pending] })),
    ]);
    await expect(h.client.runBatch([sub()])).rejects.toThrow(Judge0UnavailableError);
  });

  it('FR-503: network failure and HTTP 5xx become Judge0UnavailableError without leaking details', async () => {
    const down = harness([]);
    const err = await down.client.runBatch([sub()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Judge0UnavailableError);
    expect(String((err as Error).message)).not.toMatch(/secret-host|tok-123/);
    const five = harness([json({ error: 'x' }, 503)]);
    await expect(five.client.runBatch([sub()])).rejects.toThrow(Judge0UnavailableError);
  });
});
