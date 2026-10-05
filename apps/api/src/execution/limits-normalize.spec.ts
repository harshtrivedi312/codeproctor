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

  it('FR-503: truncate reports truncation', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncate('ab', 3)).toEqual({ text: 'ab', truncated: false });
  });
});
