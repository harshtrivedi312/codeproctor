import { ExecutionService } from '../execution/execution.service';
import { FakeJudge0Client, fakeResult } from '../judge0/fake-judge0.client';
import { JUDGE0_STATUS } from '../judge0/judge0.types';
import { StubJudge0Client } from '../judge0/stub-judge0.client';
import type { CandidateContext } from './candidate.types';
import { PRACTICE_SAMPLES } from './practice.content';
import { PracticeService } from './practice.service';

const ctx = (status: string): CandidateContext => ({ status }) as unknown as CandidateContext;

describe('Practice question (FR-406)', () => {
  const answers = new Map(PRACTICE_SAMPLES.map((s) => [s.input, s.expectedOutput]));
  const fake = (): FakeJudge0Client =>
    new FakeJudge0Client((sub) => fakeResult({ stdout: answers.get(sub.stdin ?? '') ?? '' }));
  const service = (judge: FakeJudge0Client | StubJudge0Client): PracticeService =>
    new PracticeService(new ExecutionService(judge));

  it('FR-406: serves fixed content with sample tests, three languages and starter code, before the timed test only', () => {
    const svc = service(fake());
    for (const status of ['CONSENTED', 'VERIFIED']) {
      const q = svc.question(ctx(status));
      expect(q.languages).toEqual(['python', 'javascript', 'java']);
      expect(q.sampleTests.length).toBeGreaterThanOrEqual(2);
      for (const lang of q.languages) expect(q.starterCode[lang]).not.toBe('');
    }
    for (const status of ['OPENED', 'IN_PROGRESS', 'SUBMITTED']) {
      expect(() => svc.question(ctx(status))).toThrow();
    }
  });

  it('FR-406: a correct run is completed with every sample passed and the actual output shown', async () => {
    const view = await service(fake()).run(ctx('VERIFIED'), 'python', 'print(1)');
    expect(view.outcome).toBe('completed');
    expect(view.tests.map((t) => t.status)).toEqual(PRACTICE_SAMPLES.map(() => 'passed'));
    expect(view.tests[0]).toMatchObject({ actualOutput: '7\n', expectedOutput: '7\n' });
    expect(view.stderr).toBe('');
  });

  it('FR-406: a wrong answer is completed with failed samples; a compile error is compile_error; a crash is runtime_error', async () => {
    const wrong = new FakeJudge0Client(() => fakeResult({ stdout: '0\n' }));
    expect(
      (await service(wrong).run(ctx('VERIFIED'), 'python', 'x')).tests.map((t) => t.status),
    ).toEqual(PRACTICE_SAMPLES.map(() => 'failed'));
    const compile = new FakeJudge0Client(() =>
      fakeResult({ statusId: JUDGE0_STATUS.COMPILATION_ERROR, compileOutput: 'boom' }),
    );
    expect((await service(compile).run(ctx('VERIFIED'), 'java', 'x')).outcome).toBe(
      'compile_error',
    );
    const crash = new FakeJudge0Client(() =>
      fakeResult({ statusId: JUDGE0_STATUS.RUNTIME_ERROR_NZEC, stderr: 'trace' }),
    );
    expect((await service(crash).run(ctx('VERIFIED'), 'python', 'x')).outcome).toBe(
      'runtime_error',
    );
  });

  it('DL-58: the local stub runs nothing and is never reported as passed', async () => {
    const view = await service(new StubJudge0Client()).run(ctx('VERIFIED'), 'python', 'x');
    expect(view.tests.every((t) => t.status === 'failed')).toBe(true);
    expect(view.stderr).toMatch(/stub/i);
  });

  it('FR-406: the run is refused once the test has started', async () => {
    await expect(service(fake()).run(ctx('IN_PROGRESS'), 'python', 'x')).rejects.toThrow();
  });
});
