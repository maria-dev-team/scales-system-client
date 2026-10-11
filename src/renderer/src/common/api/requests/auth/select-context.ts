import { request } from '../../request';
import type { AuthResponse } from '../../responses/auth.response';

export const selectContext = async (
  userOrganizationId: string,
  storeId?: string,
): Promise<AuthResponse> => {
  const response = await request.post('/v1/auth/select-context', {
    storeId,
    userOrganizationId,
  });
  return response.data.data.auth as AuthResponse;
};
