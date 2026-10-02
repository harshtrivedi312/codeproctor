import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from './use-autosave';

describe('autosave (FR-504)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves changed values every 10 seconds and shows the saved state', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save), {
      initialProps: { v: { a: 1 } },
    });
    expect(result.current.status).toBe('saved');

    rerender({ v: { a: 2 } });
    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ a: 2 });
    expect(result.current.status).toBe('saved');
    expect(result.current.savedAt).toBeInstanceOf(Date);
  });

  it('does not save when nothing changed', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutosave({ a: 1 }, save));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('reports an error and retries on the next tick', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe('error');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe('saved');
  });

  it('flush saves immediately (used by Run)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledWith(2);
  });
});
