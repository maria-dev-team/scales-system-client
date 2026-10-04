import { request } from '../../request';
import type { LoginResponse } from '../../responses/auth.response';
import type { LoginCredentials } from '../../types';

export const login = async (
  credentials: LoginCredentials,
): Promise<LoginResponse> => {
  const response = await request.post('/v1/auth/login', {
    ...credentials,
    clientType: 'web',
  });
  return response.data.data as LoginResponse;
};
