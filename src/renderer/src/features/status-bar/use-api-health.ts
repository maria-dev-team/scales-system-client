import { useEffect, useState } from 'react';

import { statusBarConfig } from '../../common/config/status-bar.config';

export type ApiHealth = 'unconfigured' | 'checking' | 'online' | 'offline';

export function useApiHealth(): ApiHealth {
  const apiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/g, '');
  const [state, setState] = useState<{ url: string; value: ApiHealth } | null>(
    null,
  );

  useEffect(() => {
    if (!apiUrl) return;
    let disposed = false;
    let nextCheck: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const check = async (): Promise<void> => {
      controller = new AbortController();
      timeout = setTimeout(
        () => controller?.abort(),
        statusBarConfig.healthCheckTimeoutMs,
      );
      try {
        // Health must not load auth or rotate cookies.
        const response = await fetch(`${apiUrl}/health`, {
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        });
        if (!disposed)
          setState({ url: apiUrl, value: response.ok ? 'online' : 'offline' });
      } catch {
        if (!disposed) setState({ url: apiUrl, value: 'offline' });
      } finally {
        clearTimeout(timeout);
        if (!disposed)
          nextCheck = setTimeout(
            () => void check(),
            statusBarConfig.healthCheckIntervalMs,
          );
      }
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(nextCheck);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [apiUrl]);

  return !apiUrl
    ? 'unconfigured'
    : state && state.url === apiUrl
      ? state.value
      : 'checking';
}
