import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { LOCAL_STUB_LABEL, runResponseSchema, toRunView } from './adr-wire';
import { OutputPanel } from './output-panel';
import type { RunResultView } from './source';

const base = { serverTime: '2026-10-09T10:00:00.000Z' };
const sample = (index: number, over: Record<string, unknown> = {}) => ({
  index,
  verdict: 'PASSED',
  passed: true,
  ...over,
});

describe('run results from the answers route (FR-502, DL-58)', () => {
  it('FR-502: LOCAL_STUB on every sample is a stub result: nothing ran, no tests, never a pass or a fail', () => {
    const view = toRunView({
      ...base,
      passed: 0,
      total: 2,
      results: [
        sample(1, { verdict: 'LOCAL_STUB', passed: false, stub: true, message: LOCAL_STUB_LABEL }),
        sample(2, { verdict: 'LOCAL_STUB', passed: false, stub: true, message: LOCAL_STUB_LABEL }),
      ],
    });
    expect(view).toMatchObject({ outcome: 'completed', tests: [], stub: true });
    expect(view.message).toBe(LOCAL_STUB_LABEL);
  });

  it('FR-502: a stub verdict without the stub flag, or the flag alone, is still a stub', () => {
    expect(
      toRunView({
        ...base,
        passed: 0,
        total: 1,
        results: [sample(1, { verdict: 'LOCAL_STUB', passed: false })],
      }).stub,
    ).toBe(true);
    expect(
      toRunView({
        ...base,
        passed: 0,
        total: 1,
        results: [sample(1, { verdict: 'X', passed: false, stub: true })],
      }).stub,
    ).toBe(true);
  });

  it('FR-502: real verdicts map to sample tests, with the printed output', () => {
    const view = toRunView({
      ...base,
      passed: 1,
      total: 2,
      results: [
        sample(1, { stdout: '3', timeMs: 12 }),
        sample(2, { verdict: 'FAILED', passed: false, stdout: '4' }),
      ],
    });
    expect(view.outcome).toBe('completed');
    expect(view.tests.map((t) => [t.name, t.status])).toEqual([
      ['Sample 1', 'passed'],
      ['Sample 2', 'failed'],
    ]);
    expect(view.tests[1]?.actualOutput).toBe('4');
    expect(view.stub).toBeUndefined();
    expect(view.stdout).toContain('Sample 1:\n3');
  });

  it('FR-502: compile error, runtime error, internal error and limits become an error outcome with the message', () => {
    const one = (verdict: string, message: string) =>
      toRunView({
        ...base,
        passed: 0,
        total: 1,
        results: [sample(1, { verdict, passed: false, message })],
      });
    expect(one('COMPILE_ERROR', 'SyntaxError')).toMatchObject({
      outcome: 'compile_error',
      stderr: 'SyntaxError',
    });
    expect(one('RUNTIME_ERROR', 'boom')).toMatchObject({
      outcome: 'runtime_error',
      stderr: 'boom',
    });
    expect(one('INTERNAL_ERROR', 'x').outcome).toBe('runtime_error');
    for (const v of ['TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT']) {
      expect(one(v, 'too slow').outcome).toBe('time_limit_exceeded');
    }
  });

  it('FR-502: the response schema accepts the real shape (mapped) and the screen shape (demo and tests)', () => {
    const real = runResponseSchema.safeParse({
      ...base,
      passed: 1,
      total: 1,
      results: [sample(1)],
    });
    expect(real.success && real.data.tests).toHaveLength(1);
    const own = runResponseSchema.safeParse({
      outcome: 'completed',
      tests: [],
      stdout: '',
      stderr: '',
    });
    expect(own.success).toBe(true);
    expect(runResponseSchema.safeParse({ nonsense: true }).success).toBe(false);
  });
});

describe('output panel (FR-502, DL-58, NFR-06)', () => {
  const stub: RunResultView = {
    outcome: 'completed',
    tests: [],
    stdout: '',
    stderr: '',
    stub: true,
    message: LOCAL_STUB_LABEL,
  };

  it('FR-502: a stub run says "Local stub, not real execution" and shows no pass or fail', () => {
    render(<OutputPanel running={false} result={stub} errorMessage={null} />);
    expect(screen.getByTestId('run-stub-notice')).toHaveTextContent(
      /local stub, not real execution/i,
    );
    expect(document.body.textContent).not.toMatch(/passed|failed|\d+ of \d+/i);
  });

  it('FR-502: a real run has no stub notice', () => {
    render(
      <OutputPanel
        running={false}
        errorMessage={null}
        result={{
          outcome: 'completed',
          tests: [{ id: 'a', name: 'Sample 1', status: 'passed' }],
          stdout: '',
          stderr: '',
        }}
      />,
    );
    expect(screen.queryByTestId('run-stub-notice')).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 1 sample tests passed/i)).toBeInTheDocument();
  });

  it('FR-502: a failed sample without expected output shows only what the API gave', () => {
    render(
      <OutputPanel
        running={false}
        errorMessage={null}
        result={{
          outcome: 'completed',
          tests: [{ id: 'a', name: 'Sample 1', status: 'failed', actualOutput: '4' }],
          stdout: '',
          stderr: '',
        }}
      />,
    );
    expect(screen.getByText('Your output')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });

  it('NFR-06: no axe violations on the stub notice', async () => {
    const { container } = render(<OutputPanel running={false} result={stub} errorMessage={null} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
