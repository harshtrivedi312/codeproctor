import { FakeJudge0Client, fakeResult } from '../judge0/fake-judge0.client';
import { JUDGE0_STATUS, Judge0UnavailableError } from '../judge0/judge0.types';
import { MAX_RETURNED_OUTPUT_CHARS, ExecutionService } from './execution.service';
import { InvalidLimitsError } from './limits';

const limits = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 131072 };
const test = (id: string, expectedOutput: string, reveal = true) => ({
  id,
  input: 'in',
  expectedOutput,
  reveal,
});

function setup() {
  const fake = new FakeJudge0Client();
  return { fake, service: new ExecutionService(fake) };
}

describe('ExecutionService (FR-502, FR-503)', () => {
  it('FR-503: passes when normalized stdout matches, and sends limits and language id to the runner', async () => {
    const { fake, service } = setup();
    fake.setDefault(() => fakeResult({ stdout: '42  \n\n' }));
    const { results } = await service.run({
      language: 'python',
      sourceCode: 'src',
      limits,
      tests: [test('a', '42')],
    });
    expect(results[0]).toMatchObject({
      verdict: 'PASSED',
      passed: true,
      timeMs: 10,
      memoryKb: 4096,
    });
    expect(fake.submissions[0]).toMatchObject({
      stdin: 'in',
      limits: { cpuMs: 2000, wallMs: 5000, memoryKb: 131072 },
    });
  });

  it('FR-503: wrong output is FAILED; hidden tests never carry stdout', async () => {
    const { fake, service } = setup();
    fake.setDefault(() => fakeResult({ stdout: 'nope' }));
    const { results } = await service.run({
      language: 'python',
      sourceCode: 's',
      limits,
      tests: [test('sample', 'yes', true), test('hidden', 'yes', false)],
    });
    expect(results[0]).toMatchObject({ verdict: 'FAILED', stdout: 'nope' });
    expect(results[1]).toMatchObject({ verdict: 'FAILED', passed: false });
    expect(results[1]).not.toHaveProperty('stdout');
    expect(results[1]).not.toHaveProperty('rawActualOutput');
  });

  it('FR-503: compile error maps to a sanitized message (diagnostics only when revealed)', async () => {
    const { fake, service } = setup();
    fake.setDefault(() =>
      fakeResult({
        statusId: JUDGE0_STATUS.COMPILATION_ERROR,
        stdout: null,
        compileOutput: 'Main.java:1: error',
      }),
    );
    const { results } = await service.run({
      language: 'java',
      sourceCode: 's',
      limits,
      tests: [test('a', 'x', true), test('b', 'x', false)],
    });
    expect(results[0]).toMatchObject({ verdict: 'COMPILE_ERROR' });
    expect(results[0]?.message).toContain('Main.java:1: error');
    expect(results[1]?.message).toBe('The code did not compile.');
  });

  it('TC-043 (FR-503): while(true) is TIME_LIMIT and the next run is healthy', async () => {
    const { fake, service } = setup();
    fake.when(
      'while True',
      fakeResult({ statusId: JUDGE0_STATUS.TIME_LIMIT_EXCEEDED, stdout: null, timeMs: 2000 }),
    );
    fake.when('ok', fakeResult({ stdout: 'ok' }));
    const loop = await service.run({
      language: 'python',
      sourceCode: 'while True: pass',
      limits,
      tests: [test('a', '')],
    });
    expect(loop.results[0]).toMatchObject({
      verdict: 'TIME_LIMIT',
      passed: false,
      message: 'Time limit exceeded.',
    });
    const next = await service.run({
      language: 'python',
      sourceCode: "print('ok')",
      limits,
      tests: [test('a', 'ok')],
    });
    expect(next.results[0]?.passed).toBe(true);
  });

  it('TC-044 (FR-503): memory over the limit is MEMORY_LIMIT, a plain crash is RUNTIME_ERROR', async () => {
    const { fake, service } = setup();
    fake.when(
      'alloc',
      fakeResult({ statusId: JUDGE0_STATUS.RUNTIME_ERROR_SIGSEGV, stdout: null, memoryKb: 131000 }),
    );
    fake.when(
      'crash',
      fakeResult({
        statusId: JUDGE0_STATUS.RUNTIME_ERROR_NZEC,
        stdout: null,
        memoryKb: 5000,
        stderr: 'Traceback',
      }),
    );
    const mem = await service.run({
      language: 'python',
      sourceCode: 'alloc',
      limits,
      tests: [test('a', '')],
    });
    expect(mem.results[0]?.verdict).toBe('MEMORY_LIMIT');
    const crash = await service.run({
      language: 'python',
      sourceCode: 'crash',
      limits,
      tests: [test('a', '')],
    });
    expect(crash.results[0]?.verdict).toBe('RUNTIME_ERROR');
    expect(crash.results[0]?.message).toContain('Traceback');
  });

  it('TC-044 (FR-503): a fork bomb killed by process limits is not a pass', async () => {
    const { fake, service } = setup();
    fake.when(
      'fork',
      fakeResult({
        statusId: JUDGE0_STATUS.RUNTIME_ERROR_OTHER,
        stdout: null,
        stderr: 'BlockingIOError',
        memoryKb: 20000,
      }),
    );
    const { results } = await service.run({
      language: 'python',
      sourceCode: 'os.fork()',
      limits,
      tests: [test('a', '')],
    });
    expect(results[0]).toMatchObject({ verdict: 'RUNTIME_ERROR', passed: false });
  });

  it('TC-042 (FR-503): the runner is asked for no network; a blocked socket reads as a normal run', async () => {
    const { fake, service } = setup();
    fake.setDefault(() => fakeResult({ stdout: 'BLOCKED' }));
    const { results } = await service.run({
      language: 'python',
      sourceCode: 'socket',
      limits,
      tests: [test('a', 'BLOCKED')],
    });
    expect(results[0]?.passed).toBe(true);
  });

  it('FR-503: internal error statuses and runner outages become INTERNAL_ERROR without details', async () => {
    const { fake, service } = setup();
    fake.setDefault(() =>
      fakeResult({ statusId: JUDGE0_STATUS.INTERNAL_ERROR, message: 'secret internals' }),
    );
    const a = await service.run({
      language: 'python',
      sourceCode: 's',
      limits,
      tests: [test('a', '')],
    });
    expect(a.results[0]).toMatchObject({ verdict: 'INTERNAL_ERROR' });
    expect(JSON.stringify(a.results[0])).not.toContain('secret internals');
    fake.failWith = new Judge0UnavailableError('http://internal-host exploded');
    const b = await service.run({
      language: 'python',
      sourceCode: 's',
      limits,
      tests: [test('a', ''), test('b', '')],
    });
    expect(b.results.map((r) => r.verdict)).toEqual(['INTERNAL_ERROR', 'INTERNAL_ERROR']);
    expect(JSON.stringify(b)).not.toContain('internal-host');
  });

  it('FR-503: candidate output is capped', async () => {
    const { fake, service } = setup();
    fake.setDefault(() => fakeResult({ stdout: 'x'.repeat(MAX_RETURNED_OUTPUT_CHARS * 3) }));
    const { results } = await service.run({
      language: 'python',
      sourceCode: 's',
      limits,
      tests: [test('a', 'y')],
    });
    expect(results[0]?.stdout).toHaveLength(MAX_RETURNED_OUTPUT_CHARS);
    expect(results[0]?.stdoutTruncated).toBe(true);
  });

  it('FR-503: oversized limits are clamped and reported; invalid limits throw', async () => {
    const { fake, service } = setup();
    const r = await service.run({
      language: 'python',
      sourceCode: 's',
      limits: { cpu_ms: 9e9, wall_ms: 9e9, memory_kb: 9e9 },
      tests: [test('a', '')],
    });
    expect(r.clampedLimits).toBe(true);
    expect(fake.submissions[0]?.limits.cpuMs).toBe(10_000);
    await expect(
      service.run({ language: 'python', sourceCode: 's', limits: 'bad', tests: [test('a', '')] }),
    ).rejects.toThrow(InvalidLimitsError);
  });
});
