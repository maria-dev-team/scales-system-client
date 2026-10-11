import { z } from 'zod';

import type { CatalogScope } from '../../shared/catalog';

export const ACCESS_DURATION_MS = 8 * 3600_000;
export const scopeSchema = z.object({
  apiUrl: z.string().url(),
  userId: z.string().uuid(),
  membershipId: z.string().uuid(),
  organizationId: z.string().uuid(),
  storeId: z.string().uuid(),
  storeName: z.string().min(1).max(1000),
});
export const grantSchema = z.object({
  scope: scopeSchema,
  verifiedAt: z.number().finite(),
  expiresAt: z.number().finite(),
  lastSeenAt: z.number().finite(),
});
export type CatalogGrant = z.infer<typeof grantSchema>;

export function issueGrant(
  scope: CatalogScope,
  now = Date.now(),
): CatalogGrant {
  return {
    scope,
    verifiedAt: now,
    expiresAt: now + ACCESS_DURATION_MS,
    lastSeenAt: now,
  };
}

export function grantIsValid(
  value: unknown,
  apiUrl: string,
  now = Date.now(),
): value is CatalogGrant {
  const parsed = grantSchema.safeParse(value);
  if (!parsed.success) return false;
  const grant = parsed.data;
  return (
    grant.scope.apiUrl === apiUrl &&
    now < grant.expiresAt &&
    now >= grant.lastSeenAt - 60_000 &&
    now >= grant.verifiedAt - 60_000 &&
    grant.expiresAt - grant.verifiedAt === ACCESS_DURATION_MS
  );
}

export function parseVerifiedScope(
  apiUrl: string,
  userData: unknown,
  contextData: unknown,
): CatalogScope {
  const { user } = z
    .object({ user: z.object({ id: z.string().uuid() }) })
    .parse(userData);
  const { context } = z
    .object({
      context: z.object({
        userOrganizationId: z.string().uuid(),
        organizationId: z.string().uuid(),
        storeId: z.string().uuid(),
        storeScope: z.object({
          stores: z.array(
            z.object({
              id: z.string().uuid(),
              name: z.string().min(1).max(1000),
            }),
          ),
        }),
      }),
    })
    .parse(contextData);
  const store = context.storeScope.stores.find(
    (entry) => entry.id === context.storeId,
  );
  if (!store) throw new Error('Выберите доступный магазин в Maria.');
  return {
    apiUrl,
    userId: user.id,
    membershipId: context.userOrganizationId,
    organizationId: context.organizationId,
    storeId: store.id,
    storeName: store.name,
  };
}
