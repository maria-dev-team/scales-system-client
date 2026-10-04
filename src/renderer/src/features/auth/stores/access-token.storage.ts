import { getTokenExpiration } from '@renderer/common/helpers/access-token';

const ACCESS_TOKEN_STORAGE_KEY = 'scales.access-token';
const EXPIRATION_LEEWAY_MS = 5_000;

const getSessionStorage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export const readStoredAccessToken = (): string | null => {
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const accessToken = storage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    if (!accessToken) return null;

    const expiration = getTokenExpiration(accessToken);
    if (!expiration || expiration <= Date.now() + EXPIRATION_LEEWAY_MS) {
      storage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      return null;
    }

    return accessToken;
  } catch {
    return null;
  }
};

export const storeAccessToken = (accessToken: string): void => {
  try {
    getSessionStorage()?.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
  } catch {
    // Authentication continues in memory when storage is unavailable.
  }
};

export const removeStoredAccessToken = (): void => {
  try {
    getSessionStorage()?.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // The in-memory token is still cleared by the auth store.
  }
};
