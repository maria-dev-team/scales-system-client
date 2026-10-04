import { refreshAccessToken } from '../../request';
import type { AuthResponse } from '../../responses/auth.response';

export const refreshTokens = async (): Promise<AuthResponse> => ({
  access_token: await refreshAccessToken(),
});
