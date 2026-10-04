import { afterEach, describe, expect, it } from 'vitest';

import {
  readStoredAccessToken,
  removeStoredAccessToken,
  storeAccessToken,
} from './access-token.storage';

const tokenWithExpiration = (expiration: number): string => {
  const payload = btoa(JSON.stringify({ exp: expiration })).replace(/=/g, '');
  return `header.${payload}.signature`;
};

afterEach(removeStoredAccessToken);

describe('access token storage', () => {
  it('returns a stored token whose expiration is in the future', () => {
    const token = tokenWithExpiration(Math.floor(Date.now() / 1000) + 60);

    storeAccessToken(token);

    expect(readStoredAccessToken()).toBe(token);
  });

  it('removes expired and malformed tokens', () => {
    storeAccessToken(tokenWithExpiration(Math.floor(Date.now() / 1000) - 1));
    expect(readStoredAccessToken()).toBeNull();

    storeAccessToken('malformed');
    expect(readStoredAccessToken()).toBeNull();
  });
});
