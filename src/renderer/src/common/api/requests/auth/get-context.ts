import { request } from '../../request';
import type { AuthContextResponse } from '../../responses/auth-context.response';

export const getAuthContext = async (
  signal?: AbortSignal,
): Promise<AuthContextResponse> => {
  const response = await request.get('/v1/auth/context', { signal });
  return response.data.data.context as AuthContextResponse;
};
