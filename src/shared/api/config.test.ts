import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('uses VITE_API_URL and removes trailing slashes', async () => {
  vi.stubEnv('VITE_API_URL', 'https://api.example.test///');
  const { apiConfig } = await import('./config');
  expect(apiConfig.apiUrl).toBe('https://api.example.test');
});

it.each([undefined, ''])('rejects a missing API URL (%s)', async (value) => {
  vi.stubEnv('VITE_API_URL', value);
  await expect(import('./config')).rejects.toThrow('VITE_API_URL is required.');
});
