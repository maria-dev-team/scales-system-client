import axios from 'axios';
import { create } from 'zustand';

import {
  type AccessTokenProvider,
  logout as logoutRequest,
  refreshTokens,
} from '@renderer/common/api';
import { contextChanged } from '@renderer/common/api/request';
import { effectiveAuthContext } from '@renderer/common/helpers/access-token';

import {
  readStoredAccessToken,
  removeStoredAccessToken,
  storeAccessToken,
} from './access-token.storage';

type AuthState = {
  accessToken: string | null;
  authGeneration: number;
  beginAuthChange: () => void;
  clearAccessToken: () => void;
  commitAccessToken: (accessToken: string | null) => void;
  initialize: () => Promise<void>;
  isInitialized: boolean;
  isInitializing: boolean;
  isLoggingOut: boolean;
  logout: () => Promise<void>;
  setAccessToken: (accessToken: string, renewed?: boolean) => void;
};

let initialization: Promise<void> | null = null;

export const useAuthStore = create<AuthState>()((set, get) => ({
  accessToken: readStoredAccessToken(),
  authGeneration: 0,
  beginAuthChange: () =>
    set((state) => ({ authGeneration: state.authGeneration + 1 })),
  commitAccessToken: (accessToken) => {
    if (accessToken) storeAccessToken(accessToken);
    else removeStoredAccessToken();
    set({ accessToken, isInitialized: true });
  },
  clearAccessToken: () => {
    removeStoredAccessToken();
    set((state) => ({
      accessToken: null,
      authGeneration: state.authGeneration + 1,
      isInitialized: true,
    }));
  },
  initialize: async () => {
    if (get().isInitialized) return;
    if (initialization) return initialization;
    if (get().accessToken) {
      set({ isInitialized: true });
      return;
    }
    const generation = get().authGeneration;
    set({ isInitializing: true });
    initialization = (async () => {
      try {
        const auth = await refreshTokens();
        if (get().authGeneration !== generation) throw contextChanged();
        get().setAccessToken(auth.access_token, true);
        set({ isInitialized: true });
      } catch (error) {
        if (!axios.isAxiosError(error) || error.response?.status !== 401)
          throw error;
        if (get().isInitialized) return;
        if (get().authGeneration !== generation) throw contextChanged();
        get().clearAccessToken();
      } finally {
        set({ isInitializing: false });
        initialization = null;
      }
    })();
    return initialization;
  },
  isInitialized: false,
  isInitializing: false,
  isLoggingOut: false,
  logout: async () => {
    get().beginAuthChange();
    const generation = get().authGeneration;
    set({ isLoggingOut: true });
    try {
      await logoutRequest();
      if (get().authGeneration !== generation) throw contextChanged();
    } finally {
      set({ isLoggingOut: false });
    }
  },
  setAccessToken: (accessToken, renewed = false) => {
    storeAccessToken(accessToken);
    set((state) => ({
      accessToken,
      authGeneration:
        state.authGeneration +
        (!renewed ||
        (state.accessToken !== null &&
          effectiveAuthContext(state.accessToken) !==
            effectiveAuthContext(accessToken))
          ? 1
          : 0),
    }));
  },
}));

export const authTokenProvider: AccessTokenProvider = {
  commitAccessToken: (token) =>
    useAuthStore.getState().commitAccessToken(token),
  getAuthGeneration: () => useAuthStore.getState().authGeneration,
  beginAuthChange: () => useAuthStore.getState().beginAuthChange(),
  clearAccessToken: () => useAuthStore.getState().clearAccessToken(),
  getAccessToken: () => useAuthStore.getState().accessToken,
  setAccessToken: (accessToken) =>
    useAuthStore.getState().setAccessToken(accessToken, true),
};
