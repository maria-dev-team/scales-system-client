import { request } from '../../request';
import type { UserResponse } from '../../responses/user.response';

export const getCurrentUser = async (): Promise<UserResponse> => {
  const response = await request.get('/v1/users/me');
  return response.data.data.user as UserResponse;
};
