// @vitest-environment node
import { expect, it } from 'vitest';

import { requestCatalogApi } from './api';

it('reads the data envelope and sends credentials only to the configured API', async () => {
  let observed: { url: string; options?: RequestInit } | undefined;
  const result = await requestCatalogApi(
    'https://api.test',
    'secret',
    '/v1/pos/catalog/sync-start?unit=kg',
    new AbortController().signal,
    async (url, options) => {
      observed = { url: String(url), options };
      return new Response(JSON.stringify({ data: { cursor: 'ok' } }));
    },
  );
  expect(result).toEqual({ cursor: 'ok' });
  expect(observed).toMatchObject({
    url: 'https://api.test/v1/pos/catalog/sync-start?unit=kg',
    options: { redirect: 'error', headers: { Authorization: 'Bearer secret' } },
  });
});

it('preserves backend status and cooldown even when the response is not JSON', async () => {
  await expect(
    requestCatalogApi(
      'https://api.test',
      'secret',
      '/v1/pos/catalog/page?unit=kg',
      new AbortController().signal,
      async () =>
        new Response('Proxy limited', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    ),
  ).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
});

it('bounds actual response bytes when the server omits Content-Length', async () => {
  await expect(
    requestCatalogApi(
      'https://api.test',
      'secret',
      '/v1/pos/catalog/page?unit=kg',
      new AbortController().signal,
      async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    ),
  ).rejects.toThrow(/размер/);
});

it('does not leak a bearer token in connectivity errors', async () => {
  try {
    await requestCatalogApi(
      'https://api.test',
      'secret',
      '/v1/pos/catalog/page?unit=kg',
      new AbortController().signal,
      async () => {
        throw new Error('secret fetch failure');
      },
    );
  } catch (error) {
    expect(String(error)).not.toContain('secret');
    expect(String(error)).toContain('api.test');
    return;
  }
  throw new Error('Expected transport failure');
});
