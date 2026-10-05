// Real Judge0 integration (TC-042, TC-043, TC-044; FR-503). Skipped unless JUDGE0_URL is set and
// JUDGE0_INTEGRATION=true. Needs a Linux x86 host with the sandbox (R-01); it is NOT enabled in CI
// until ARC-05 confirms the host, and it is not validated on macOS/arm64. Run with:
//   JUDGE0_URL=http://127.0.0.1:2358 JUDGE0_AUTH_TOKEN=... JUDGE0_AUTHZ_TOKEN=... \
//   JUDGE0_INTEGRATION=true pnpm --filter @codeproctor/api test judge0.integration
import { ExecutionService } from '../execution/execution.service';
import { HttpJudge0Client } from './http-judge0.client';
import type { ExecLanguage } from './language-map';

const enabled = Boolean(process.env.JUDGE0_URL) && process.env.JUDGE0_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;

suite('Judge0 sandbox integration', () => {
  // Built lazily: a skipped describe body still executes.
  const makeService = () =>
    new ExecutionService(
      new HttpJudge0Client({
        baseUrl: process.env.JUDGE0_URL as string,
        authToken: process.env.JUDGE0_AUTH_TOKEN,
        authzToken: process.env.JUDGE0_AUTHZ_TOKEN,
        requestTimeoutMs: 10_000,
        pollDeadlineMs: 60_000,
      }),
    );
  const limits = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 131_072 };
  const run = async (language: ExecLanguage, sourceCode: string, expectedOutput = '') => {
    const { results } = await makeService().run({
      language,
      sourceCode,
      limits,
      tests: [{ id: 't', input: '', expectedOutput, reveal: true }],
    });
    return results[0];
  };

  it('TC-042 (FR-503): a socket to the internet fails', async () => {
    const r = await run(
      'python',
      [
        'import socket',
        's = socket.socket()',
        's.settimeout(3)',
        'try:',
        "    s.connect(('1.1.1.1', 80)); print('CONNECTED')",
        'except Exception:',
        "    print('BLOCKED')",
      ].join('\n'),
      'BLOCKED',
    );
    expect(r?.passed).toBe(true);
  }, 90_000);

  it('TC-043 (FR-503): while(true) hits the time limit and the runner stays healthy', async () => {
    const r = await run('python', 'while True:\n    pass');
    expect(r?.verdict).toBe('TIME_LIMIT');
    const after = await run('python', "print('ok')", 'ok');
    expect(after?.passed).toBe(true);
  }, 90_000);

  it('TC-044 (FR-503): fork bomb and large allocation are killed by limits', async () => {
    const fork = await run('python', 'import os\nwhile True:\n    os.fork()');
    expect(fork?.passed).toBe(false);
    expect(['TIME_LIMIT', 'RUNTIME_ERROR', 'MEMORY_LIMIT']).toContain(fork?.verdict);
    const mem = await run('python', "x = bytearray(2 * 1024 * 1024 * 1024)\nprint('done')");
    expect(mem?.passed).toBe(false);
    const after = await run('python', "print('ok')", 'ok');
    expect(after?.passed).toBe(true);
  }, 120_000);

  it('FR-503: submissions are deleted after a run (GET of the token answers 404)', async () => {
    const base = (process.env.JUDGE0_URL as string).replace(/\/+$/, '');
    const headers: Record<string, string> = {};
    if (process.env.JUDGE0_AUTH_TOKEN) headers['X-Auth-Token'] = process.env.JUDGE0_AUTH_TOKEN;
    const tokens: string[] = [];
    const spyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === 'POST') {
        const body = (await response.clone().json()) as { token: string }[];
        tokens.push(...body.map((b) => b.token));
      }
      return response;
    };
    const client = new HttpJudge0Client({
      baseUrl: base,
      authToken: process.env.JUDGE0_AUTH_TOKEN,
      authzToken: process.env.JUDGE0_AUTHZ_TOKEN,
      requestTimeoutMs: 10_000,
      pollDeadlineMs: 60_000,
      fetchFn: spyFetch,
    });
    await new ExecutionService(client).run({
      language: 'python',
      sourceCode: "print('ok')",
      limits,
      tests: [{ id: 't', input: '', expectedOutput: 'ok', reveal: true }],
    });
    expect(tokens).toHaveLength(1);
    const res = await fetch(`${base}/submissions/${tokens[0]}?fields=token`, { headers });
    expect(res.status).toBe(404);
  }, 90_000);
});
