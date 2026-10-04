import axios, {
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';

import { ErrorCode } from '../constants/error-code';
import {
  effectiveAuthContext,
  getTokenExpiration,
} from '../helpers/access-token';
import {
  beginAuthChange,
  clearAccessToken,
  commitAccessToken,
  getAccessToken,
  getAuthGeneration,
  resyncAuth,
  setAccessToken,
} from './access-token.provider';
import { apiConfig } from './config/api.config';
import { serializeRequestData } from './request-data.serializer';

const clientConfig = {
  baseURL: apiConfig.apiUrl,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
  withCredentials: true,
};

export const request = axios.create(clientConfig);
const refreshClient = axios.create(clientConfig);

type AuthSnapshot = {
  token: string | null;
  generation: number;
  root: string | null;
  context: string;
};

type RetriableRequestConfig = InternalAxiosRequestConfig & {
  retry?: boolean;
  transportAdapter?: AxiosAdapter;
  authSnapshot?: AuthSnapshot;
};

let authQueue: Promise<unknown> = Promise.resolve();
const serializeAuth = <T>(operation: () => Promise<T>): Promise<T> => {
  const pending = authQueue.then(operation, operation);
  authQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};
const readAuthToken = (data: unknown): string => {
  const body = typeof data === 'string' ? JSON.parse(data) : data;
  const token: unknown = body?.data?.auth?.access_token;
  if (typeof token !== 'string' || !token.trim() || token.length > 16384)
    throw new Error('Сервер вернул некорректный токен доступа.');
  return token;
};

let refreshPromise: Promise<string> | null = null;
let lastRotation: {
  root: string | null;
  current: string;
  generation: number;
} | null = null;
export const contextChanged = (): Error & { code: string } =>
  Object.assign(
    new Error(
      'Вход или магазин изменился во время запроса. Повторите действие в текущем контексте.',
    ),
    { code: 'AUTH_CONTEXT_CHANGED' },
  );

export const captureAuth = (): AuthSnapshot => {
  const token = getAccessToken();
  const generation = getAuthGeneration();
  return {
    token,
    generation,
    root:
      lastRotation?.current === token && lastRotation.generation === generation
        ? lastRotation.root
        : token,
    context: effectiveAuthContext(token),
  };
};

export const assertAuthCurrent = (snapshot: AuthSnapshot): void => {
  const current = captureAuth();
  if (
    snapshot.generation !== current.generation ||
    snapshot.context !== current.context ||
    (snapshot.token !== current.token &&
      (snapshot.root !== current.root ||
        lastRotation?.current !== current.token))
  )
    throw contextChanged();
};

export const waitForAuthRefresh = (): Promise<string> | null => refreshPromise;

request.interceptors.request.use(
  (config: RetriableRequestConfig) => {
    // Capture synchronously; async Axios interceptors otherwise observe a later login.
    if (
      !config.authSnapshot &&
      [
        '/v1/auth/login',
        '/v1/auth/register',
        '/v1/auth/select-context',
      ].includes(config.url ?? '')
    )
      beginAuthChange();
    config.authSnapshot ??= captureAuth();
    config.transportAdapter ??= axios.getAdapter(config.adapter);
    config.adapter = async (rawConfig) => {
      const dispatch = rawConfig as RetriableRequestConfig;
      const send = async () => {
        assertAuthCurrent(dispatch.authSnapshot!);
        const token = getAccessToken();
        if (token) dispatch.headers.set('Authorization', `Bearer ${token}`);
        else dispatch.headers.delete('Authorization');
        const response = await dispatch.transportAdapter!(dispatch);
        assertAuthCurrent(dispatch.authSnapshot!);
        if (
          isAuthRequest(dispatch.url) ||
          dispatch.url === '/v1/auth/select-context'
        ) {
          commitAccessToken(
            dispatch.url === '/v1/auth/logout'
              ? null
              : readAuthToken(response.data),
          );
          dispatch.authSnapshot = captureAuth();
        }
        return response;
      };
      if (isAuthRequest(dispatch.url)) return serializeAuth(send);
      const pendingRefresh = refreshPromise;
      await authQueue;
      assertAuthCurrent(dispatch.authSnapshot!);
      if (pendingRefresh || refreshPromise) {
        try {
          await (pendingRefresh ?? refreshPromise);
        } catch (error) {
          assertAuthCurrent(dispatch.authSnapshot!);
          if (dispatch.url === '/v1/auth/select-context')
            await refreshAccessToken();
          else throw error;
        }
      } else {
        const token = getAccessToken();
        const expiration = token ? getTokenExpiration(token) : null;
        if (
          expiration !== null &&
          expiration <= Date.now() + 5_000 &&
          !dispatch.retry
        )
          await refreshAccessToken();
      }
      return dispatch.url === '/v1/auth/select-context'
        ? serializeAuth(send)
        : send();
    };
    if (config.data instanceof FormData) config.headers.delete('Content-Type');
    else config.data = serializeRequestData(config.data);
    config.params = serializeRequestData(config.params);
    return config;
  },
  undefined,
  { synchronous: true },
);

const isAuthRequest = (url?: string): boolean =>
  url === '/v1/auth/login' ||
  url === '/v1/auth/register' ||
  url === '/v1/auth/logout' ||
  url === '/v1/auth/refresh';

const shouldAttemptRefresh = (
  status: number | undefined,
  errorCode: string | undefined,
  originalRequest: RetriableRequestConfig,
): boolean =>
  status === 401 &&
  !originalRequest.retry &&
  !isAuthRequest(originalRequest.url) &&
  (errorCode === ErrorCode.InvalidToken ||
    errorCode === ErrorCode.InvalidSession ||
    !errorCode);

export const refreshAccessToken = (): Promise<string> => {
  if (!refreshPromise) {
    const generation = getAuthGeneration();
    refreshPromise = serializeAuth(async () => {
      if (getAuthGeneration() !== generation) throw contextChanged();
      const snapshot = captureAuth();
      try {
        const { data } = await refreshClient.post('/v1/auth/refresh', {});
        if (
          getAuthGeneration() !== generation ||
          getAccessToken() !== snapshot.token
        )
          throw contextChanged();
        const token = readAuthToken(data);
        setAccessToken(token);
        lastRotation = {
          root: snapshot.root,
          current: token,
          generation: getAuthGeneration(),
        };
        if (snapshot.token && snapshot.context !== effectiveAuthContext(token))
          resyncAuth();
        return token;
      } catch (error) {
        if (
          getAuthGeneration() !== generation ||
          getAccessToken() !== snapshot.token
        )
          throw contextChanged();
        if (axios.isAxiosError(error) && error.response?.status === 401)
          clearAccessToken();
        throw error;
      }
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

request.interceptors.response.use(
  (response) => {
    const snapshot = (response.config as RetriableRequestConfig).authSnapshot;
    if (snapshot) assertAuthCurrent(snapshot);
    return response;
  },
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) throw error;

    const originalRequest = error.config as RetriableRequestConfig;
    const status = error.response?.status;
    const errorCode = error.response?.data?.error_code as string | undefined;

    if (originalRequest.authSnapshot)
      assertAuthCurrent(originalRequest.authSnapshot);
    if (status === 409 && errorCode === 'AUTH_STATE_CHANGED') {
      const context = effectiveAuthContext(getAccessToken());
      await refreshAccessToken();
      if (context === effectiveAuthContext(getAccessToken())) resyncAuth();
      throw error;
    }
    if (
      status === 401 &&
      originalRequest.retry &&
      originalRequest.headers.get('Authorization') ===
        `Bearer ${getAccessToken()}`
    )
      clearAccessToken();
    if (!shouldAttemptRefresh(status, errorCode, originalRequest)) throw error;

    originalRequest.retry = true;
    const sent = originalRequest.headers.get('Authorization');
    const current = getAccessToken();
    const sentToken =
      typeof sent === 'string' && sent.startsWith('Bearer ')
        ? sent.slice(7)
        : null;
    if (current === sentToken) await refreshAccessToken();
    if (originalRequest.authSnapshot)
      assertAuthCurrent(originalRequest.authSnapshot);
    return request(originalRequest);
  },
);
