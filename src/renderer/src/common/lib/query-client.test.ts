import { MutationObserver } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { configureAccessTokenProvider } from '../api/access-token.provider';
import { createQueryClient } from './query-client';

describe('authentication query retry policy', () => {
  it('rejects a delayed mutation before its callback can cache data for a newer login', async () => {
    let generation = 0;
    configureAccessTokenProvider({
      getAuthGeneration: () => generation,
      getAccessToken: () => 'same-token',
      setAccessToken: () => undefined,
      clearAccessToken: () => undefined,
    });
    const client = createQueryClient();
    let finish!: (value: string) => void;
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      onSuccess: (data) => {
        client.setQueryData(['old-context'], data);
      },
    });
    const pending = mutation.execute(undefined);
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    generation++;
    finish('stale value');
    await checked;
    expect(client.getQueryData(['old-context'])).toBeUndefined();
    client.clear();
  });

  it.each([true, false])(
    'allows the owned auth operation callback (success=%s)',
    async (success) => {
      let generation = 0;
      let token: string | null = 'old-token';
      configureAccessTokenProvider({
        getAuthGeneration: () => generation,
        getAccessToken: () => token,
        setAccessToken: () => undefined,
        clearAccessToken: () => undefined,
      });
      const client = createQueryClient();
      const failure = new Error('Invalid credentials');
      const onError = vi.fn();
      const mutation = client.getMutationCache().build(client, {
        mutationFn: async () => {
          generation++;
          if (!success) throw failure;
          token = 'new-token';
          return { auth: { access_token: 'new-token' } };
        },
        onSuccess: (data) => {
          token = data.auth.access_token;
        },
        onError,
      });
      if (success) {
        await mutation.execute(undefined);
        expect(token).toBe('new-token');
      } else {
        await expect(mutation.execute(undefined)).rejects.toBe(failure);
        expect(onError).toHaveBeenCalledWith(
          failure,
          undefined,
          undefined,
          expect.anything(),
        );
        expect(token).toBe('old-token');
      }
      client.clear();
    },
  );

  it('suppresses a stale error callback before it can restore old cache data', async () => {
    let generation = 0;
    configureAccessTokenProvider({
      getAuthGeneration: () => generation,
      getAccessToken: () => 'same-token',
      setAccessToken: () => undefined,
      clearAccessToken: () => undefined,
    });
    const client = createQueryClient();
    let fail!: (error: Error) => void;
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      onError: () => {
        client.setQueryData(['old-context'], 'rollback');
      },
    });
    const pending = mutation.execute(undefined);
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    generation++;
    fail(new Error('Old request failed'));
    await checked;
    expect(client.getQueryData(['old-context'])).toBeUndefined();
    client.clear();
  });

  it('keeps execution ownership when a pending observer receives rerendered options', async () => {
    let generation = 0;
    configureAccessTokenProvider({
      getAuthGeneration: () => generation,
      getAccessToken: () => 'same-token',
      setAccessToken: () => undefined,
      clearAccessToken: () => undefined,
    });
    const client = createQueryClient();
    let finish!: (value: string) => void;
    const options = {
      mutationFn: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      onSuccess: (data: string) => {
        client.setQueryData(['old-context'], data);
      },
    };
    const observer = new MutationObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    const pending = observer.mutate(undefined);
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    observer.setOptions({
      ...options,
      onSuccess: (data) => {
        client.setQueryData(['old-context'], data);
      },
    });
    generation++;
    finish('stale value');
    await checked;
    expect(client.getQueryData(['old-context'])).toBeUndefined();
    unsubscribe();
    client.clear();
  });

  it.each([401, 403, 409])(
    'does not retry a final auth error with status %s',
    async (status) => {
      const client = createQueryClient();
      const queryFn = vi.fn().mockRejectedValue(
        new AxiosError('Auth changed', undefined, undefined, undefined, {
          status,
          data: { error_code: 'AUTH_STATE_CHANGED' },
        } as never),
      );
      await expect(
        client.fetchQuery({ queryKey: ['test'], queryFn, retryDelay: 0 }),
      ).rejects.toThrow();
      expect(queryFn).toHaveBeenCalledTimes(1);
      client.clear();
    },
  );
  it.each(['AUTH_CONTEXT_CHANGED', 'LOCAL_CONTEXT_CHANGED'])(
    'does not retry %s',
    async (code) => {
      const client = createQueryClient();
      const queryFn = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Context changed'), { code }),
        );
      await expect(
        client.fetchQuery({ queryKey: ['test'], queryFn, retryDelay: 0 }),
      ).rejects.toThrow();
      expect(queryFn).toHaveBeenCalledTimes(1);
      client.clear();
    },
  );
});
