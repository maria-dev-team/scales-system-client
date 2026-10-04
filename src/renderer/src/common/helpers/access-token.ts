type AccessTokenClaims = {
  exp?: number;
  sub?: string;
  sid?: string;
  userOrganizationId?: string;
  organizationId?: string;
  storeId?: string;
};

export const decodeAccessToken = (
  accessToken: string | null,
): AccessTokenClaims | null => {
  try {
    const encoded = accessToken?.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    );
  } catch {
    return null;
  }
};

export const getTokenExpiration = (accessToken: string): number | null => {
  const exp = decodeAccessToken(accessToken)?.exp;
  return typeof exp === 'number' ? exp * 1_000 : null;
};

export const effectiveAuthContext = (token: string | null): string => {
  const claims = decodeAccessToken(token);
  return JSON.stringify([
    claims?.sub,
    claims?.userOrganizationId,
    claims?.organizationId,
    claims?.storeId,
  ]);
};
