export type AccessTokenProvider = {
  commitAccessToken?: (accessToken: string | null) => void;
  resyncAuth?: () => void;
  getAuthGeneration?: () => number;
  beginAuthChange?: () => void;
  clearAccessToken: () => void;
  getAccessToken: () => string | null;
  setAccessToken: (accessToken: string) => void;
};

const emptyProvider: AccessTokenProvider = {
  clearAccessToken: () => undefined,
  getAccessToken: () => null,
  setAccessToken: () => undefined,
};

let accessTokenProvider = emptyProvider;

export const configureAccessTokenProvider = (
  provider: AccessTokenProvider,
): void => {
  accessTokenProvider = provider;
};

export const clearAccessToken = (): void =>
  accessTokenProvider.clearAccessToken();
export const getAccessToken = (): string | null =>
  accessTokenProvider.getAccessToken();
export const setAccessToken = (accessToken: string): void =>
  accessTokenProvider.setAccessToken(accessToken);

export const getAuthGeneration = (): number =>
  accessTokenProvider.getAuthGeneration?.() ?? 0;
export const beginAuthChange = (): void => {
  accessTokenProvider.beginAuthChange?.();
};

export const resyncAuth = (): void => {
  accessTokenProvider.resyncAuth?.();
};

export const commitAccessToken = (token: string | null): void => {
  if (accessTokenProvider.commitAccessToken)
    accessTokenProvider.commitAccessToken(token);
  else if (token) accessTokenProvider.setAccessToken(token);
  else accessTokenProvider.clearAccessToken();
};
