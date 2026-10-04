import { MutationCache, QueryClient } from '@tanstack/react-query';
import axios from 'axios';

import { assertAuthCurrent, captureAuth, contextChanged } from '../api/request';
import { effectiveAuthContext } from '../helpers/access-token';

export const shouldRetryQuery = (
  failureCount: number,
  error: Error,
): boolean => {
  if (
    error &&
    'code' in error &&
    ['AUTH_CONTEXT_CHANGED', 'LOCAL_CONTEXT_CHANGED'].includes(
      String(error.code),
    )
  )
    return false;
  if (
    axios.isAxiosError(error) &&
    ([401, 403].includes(error.response?.status ?? 0) ||
      error.response?.data?.error_code === 'AUTH_STATE_CHANGED')
  )
    return false;
  return failureCount < 1;
};

export const createQueryClient = (): QueryClient => {
  type Execution = {
    auth: ReturnType<typeof captureAuth>;
    producingAuth?: ReturnType<typeof captureAuth>;
  };
  const owners = new WeakMap<object, Execution>();
  return new QueryClient({
    mutationCache: new MutationCache({
      onMutate: (_variables, mutation) => {
        const existing = owners.get(mutation);
        if (existing) {
          existing.auth = captureAuth();
          existing.producingAuth = undefined;
          return;
        }
        const execution: Execution = { auth: captureAuth() };
        owners.set(mutation, execution);
        const setOptions = mutation.setOptions.bind(mutation);
        // MutationObserver replaces pending options on rerender; keep guards at actual invocation.
        mutation.setOptions = (options) => {
          const ownsCallback = (): boolean => {
            try {
              assertAuthCurrent(execution.producingAuth ?? execution.auth);
              return true;
            } catch {
              return false;
            }
          };
          const ownsResult = (data: unknown): boolean => {
            if (ownsCallback()) return true;
            const auth = data as {
              auth?: { access_token?: unknown };
              access_token?: unknown;
            } | null;
            const returnedToken =
              auth?.auth?.access_token ?? auth?.access_token;
            if (typeof returnedToken !== 'string' || !returnedToken)
              return false;
            // Auth is committed before the response leaves the serialized cookie operation.
            try {
              assertAuthCurrent({
                generation: (execution.producingAuth ?? execution.auth)
                  .generation,
                token: returnedToken,
                root: returnedToken,
                context: effectiveAuthContext(returnedToken),
              });
              return true;
            } catch {
              return false;
            }
          };
          setOptions({
            ...options,
            mutationFn: async (...args) => {
              assertAuthCurrent(execution.auth);
              try {
                const pending = options.mutationFn!(...args);
                execution.producingAuth = captureAuth();
                const result = await pending;
                if (!ownsResult(result)) throw contextChanged();
                return result;
              } catch (error) {
                if (!ownsCallback()) throw contextChanged();
                throw error;
              }
            },
            onSuccess: (...args) => {
              if (!ownsResult(args[0])) throw contextChanged();
              return options.onSuccess?.(...args);
            },
            onError: (...args) => {
              if (ownsCallback()) return options.onError?.(...args);
              return undefined;
            },
          });
        };
        mutation.setOptions(mutation.options);
      },
    }),
    defaultOptions: {
      mutations: { retry: false, networkMode: 'always' },
      queries: {
        networkMode: 'always',
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        staleTime: 30_000,
      },
    },
  });
};
