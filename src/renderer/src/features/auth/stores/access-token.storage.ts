import {
  effectiveAuthContext,
  getTokenExpiration,
} from '@renderer/common/helpers/access-token';

const ACCESS_TOKEN_STORAGE_KEY = 'scales.access-token';
const EXPIRATION_LEEWAY_MS = 5_000;
const PENDING_STORE_KEY = 'scales.pending-store-selection';
let pendingStoreContext: string | null = null;

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
  markPendingStoreSelection(null);
  try {
    getSessionStorage()?.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // The in-memory token is still cleared by the auth store.
  }
};

// This is a navigation marker, not an authorization grant. Bind it to the
// context so an unfinished choice cannot carry over to another account/store.
export const markPendingStoreSelection = (accessToken: string | null): void => {
  pendingStoreContext = accessToken ? effectiveAuthContext(accessToken) : null;
  try {
    const storage = getSessionStorage();
    if (pendingStoreContext)
      storage?.setItem(PENDING_STORE_KEY, pendingStoreContext);
    else storage?.removeItem(PENDING_STORE_KEY);
  } catch {
    // Keep navigation state in memory when browser storage is unavailable.
  }
};

export const hasPendingStoreSelection = (
  accessToken: string | null,
): boolean => {
  try {
    const storage = getSessionStorage();
    if (storage) pendingStoreContext = storage.getItem(PENDING_STORE_KEY);
  } catch {
    // Fall back to the marker from this renderer session.
  }
  return (
    accessToken !== null &&
    pendingStoreContext === effectiveAuthContext(accessToken)
  );
};
