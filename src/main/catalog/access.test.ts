// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { grantIsValid, issueGrant, parseVerifiedScope } from './access';

const scope = {
  apiUrl: 'https://api.example.test',
  userId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  storeId: '00000000-0000-4000-8000-000000000004',
  storeName: 'Shop',
};

describe('cached catalog access', () => {
  it('expires after eight hours, rejects clock rollback and a different API', () => {
    const now = Date.now();
    const grant = issueGrant(scope, now);
    expect(grantIsValid(grant, scope.apiUrl, now + 60_000)).toBe(true);
    expect(grantIsValid(grant, scope.apiUrl, now + 8 * 3600_000)).toBe(false);
    expect(grantIsValid(grant, scope.apiUrl, now - 60_001)).toBe(false);
    expect(grantIsValid(grant, 'https://another.test', now)).toBe(false);
    expect(
      grantIsValid(
        { ...grant, expiresAt: now + 9 * 3600_000 },
        scope.apiUrl,
        now,
      ),
    ).toBe(false);
  });

  it('takes identity and store from verified responses, requiring an available store', () => {
    const context = {
      userOrganizationId: scope.membershipId,
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      storeScope: { stores: [{ id: scope.storeId, name: scope.storeName }] },
    };
    expect(
      parseVerifiedScope(
        scope.apiUrl,
        { user: { id: scope.userId } },
        { context },
      ),
    ).toEqual(scope);
    expect(() =>
      parseVerifiedScope(
        scope.apiUrl,
        { user: { id: scope.userId } },
        { context: { ...context, storeScope: { stores: [] } } },
      ),
    ).toThrow();
  });
});
