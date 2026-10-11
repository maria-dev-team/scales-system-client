import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApiHealth } from './use-api-health';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('status bar server availability', () => {
  it('does not request anything without a configured API', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(useApiHealth);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current).toBe('unconfigured');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks health without session credentials and follows server recovery', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test/');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const { result, unmount } = renderHook(useApiHealth);
    await act(async () => {});
    expect(result.current).toBe('online');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/health',
      expect.objectContaining({ credentials: 'omit' }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current).toBe('offline');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current).toBe('online');
    unmount();
    const count = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it('times out a stalled request and cancels it on unmount', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signals.push(signal);
            signal.addEventListener(
              'abort',
              () => reject(new Error('Aborted')),
              { once: true },
            );
          }),
      ),
    );
    const { result, unmount } = renderHook(useApiHealth);
    expect(result.current).toBe('checking');
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current).toBe('offline');
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });
});
