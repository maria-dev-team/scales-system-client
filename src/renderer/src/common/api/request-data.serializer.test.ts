import { describe, expect, it } from 'vitest';

import { serializeRequestData } from './request-data.serializer';

describe('serializeRequestData', () => {
  it('converts nested object keys to snake_case without changing scalar values', () => {
    expect(
      serializeRequestData({
        storeId: 'store-1',
        nestedItems: [{ userOrganizationId: 'membership-1' }],
        empty: null,
      }),
    ).toEqual({
      store_id: 'store-1',
      nested_items: [{ user_organization_id: 'membership-1' }],
      empty: null,
    });
  });

  it('leaves FormData unchanged', () => {
    const formData = new FormData();

    expect(serializeRequestData(formData)).toBe(formData);
  });
});
