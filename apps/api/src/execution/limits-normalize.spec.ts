import { DEFAULT_LIMITS, InvalidLimitsError, LIMIT_CAPS, resolveLimits } from './limits';
import { normalizeOutput, outputsMatch, truncate } from './normalize';

describe('limits (FR-503)', () => {
  it('FR-503: accepts the column default unchanged', () => {
    expect(resolveLimits(DEFAULT_LIMITS)).toEqual({
      cpuMs: 2000,
      wallMs: 5000,
      memoryKb: 262144,
      clamped: false,
    });
  });

  it('FR-503: hard caps lower oversized question limits', () => {
    const r = resolveLimits({ cpu_ms: 999_999, wall_ms: 999_999, memory_kb: 99_999_999 });
    expect(r).toEqual({
      cpuMs: LIMIT_CAPS.cpu_ms,
      wallMs: LIMIT_CAPS.wall_ms,
      memoryKb: LIMIT_CAPS.memory_kb,
      clamped: true,
    });
  });

  it('FR-503: wall time is never below CPU time', () => {
    expect(resolveLimits({ cpu_ms: 3000, wall_ms: 1000, memory_kb: 65536 }).wallMs).toBe(3000);
  });

  it.each([
    [null],
    [{}],
    [{ cpu_ms: -1, wall_ms: 5000, memory_kb: 65536 }],
    [{ cpu_ms: '2000', wall_ms: 5000, memory_kb: 65536 }],
    [{ cpu_ms: 2000.5, wall_ms: 5000, memory_kb: 65536 }],
    [{ cpu_ms: 2000, wall_ms: 5000, memory_kb: 1 }],
  ])('FR-503: rejects invalid limits %j', (raw) => {
    expect(() => resolveLimits(raw)).toThrow(InvalidLimitsError);
  });
});

describe('output normalization (FR-503)', () => {
  it('FR-503: trims trailing whitespace per line and overall, keeps leading whitespace', () => {
    expect(normalizeOutput('a  \r\n  b\t\n\n\n')).toBe('a\n  b');
    expect(outputsMatch('1 2 3 \n', '1 2 3')).toBe(true);
    expect(outputsMatch(' 1', '1')).toBe(false);
    expect(outputsMatch('1\n\n2', '1\n2')).toBe(false);
  });

  it('FR-503: long whitespace runs normalize correctly', () => {
    expect(normalizeOutput(' '.repeat(65536) + 'x')).toBe(' '.repeat(65536) + 'x');
    expect(normalizeOutput('x' + ' '.repeat(65536) + '\n' + ' \n'.repeat(30000))).toBe('x');
    expect(normalizeOutput(' \t'.repeat(32768) + 'x ' + '\n'.repeat(10000))).toBe(
      ' \t'.repeat(32768) + 'x',
    );
  });

  // ReDoS guard without an absolute time limit (a wall-clock threshold flaked on loaded CI
  // runners): the cost must grow about linearly. Quadratic work would take about 16x as long for
  // 4x the input, linear about 4x, so the bound sits between. The two sizes are measured
  // interleaved (small, large, small, large, ...) and each keeps its fastest run, so a busy runner
  // that slows one phase cannot skew the ratio, and the runs it did slow are discarded.
  it('FR-503: normalization cost grows linearly with the input (no ReDoS)', () => {
    const worstCase = (n: number): string =>
      // A long run followed by a non-space is the shape that makes `\s+$` regexes quadratic;
      // CR runs and form feed / vertical tab runs cover the other whitespace paths.
      ' '.repeat(n) +
      'x\n' +
      'x' +
      ' \t'.repeat(n) +
      '\n' +
      ' \n'.repeat(n) +
      ' '.repeat(n) +
      '\r'.repeat(n) +
      'x\r\n' +
      ' \f\v'.repeat(n) +
      '\r\n';
    const small = 32_768;
    const inputs = [worstCase(small), worstCase(small * 4)];
    const best = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const timeOnce = (input: string): number => {
      const t0 = process.hrtime.bigint();
      normalizeOutput(input);
      return Number(process.hrtime.bigint() - t0);
    };
    timeOnce(inputs[0] ?? ''); // warm the JIT before measuring
    for (let i = 0; i < 7; i += 1) {
      for (const k of [0, 1] as const) {
        best[k] = Math.min(best[k] ?? Number.POSITIVE_INFINITY, timeOnce(inputs[k] ?? ''));
      }
    }
    const ratio = Math.max(best[1] ?? 1, 1) / Math.max(best[0] ?? 1, 1);
    expect(ratio).toBeLessThan(10);
  });

  it('FR-503: truncate reports truncation', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncate('ab', 3)).toEqual({ text: 'ab', truncated: false });
  });
});
