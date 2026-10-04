import { request } from '../../request';

export const logout = async (): Promise<void> => {
  await request.post('/v1/auth/logout', {});
};
