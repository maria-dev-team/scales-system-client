export const ErrorCode = {
  InvalidCredentials: 'INVALID_CREDENTIALS',
  InvalidSession: 'INVALID_SESSION',
  InvalidToken: 'INVALID_TOKEN',
  TooManyRequests: 'TOO_MANY_REQUESTS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
