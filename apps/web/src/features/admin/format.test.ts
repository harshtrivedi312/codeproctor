import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockedUntilText } from './format';

afterEach(() => vi.useRealTimers());

describe('lockedUntilText (FR-101)', () => {
  it('FR-101: a lock that ends today shows only the clock time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 12, 0, 0));
    const text = lockedUntilText(new Date(2026, 9, 10, 12, 15, 0).toISOString());
    expect(text).toMatch(/^Locked until \S+/);
    expect(text).not.toContain('Oct');
  });

  it('FR-101: a lock that ends on another day says which day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 23, 55, 0));
    const text = lockedUntilText(new Date(2026, 9, 11, 0, 10, 0).toISOString());
    expect(text).toMatch(/^Locked until .*11.*, /);
  });

  it('FR-101: no end time says only Locked', () => {
    expect(lockedUntilText(null)).toBe('Locked');
  });
});
