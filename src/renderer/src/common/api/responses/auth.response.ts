import type { UserResponse } from './user.response';

export type AuthResponse = {
  access_token: string;
};

export type LoginResponse = {
  auth: AuthResponse;
  user: UserResponse;
};
