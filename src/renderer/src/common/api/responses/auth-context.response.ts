export type AuthContextResponse = {
  isSystemPosition?: boolean;
  organizationId?: string;
  permissions: string[];
  position?: string;
  storeId: string | null;
  storeScope: {
    canAccessAll: boolean;
    primaryStoreId: string | null;
    storeIds: string[];
    stores: Array<{ address: string | null; id: string; name: string }>;
  };
  userOrganizationId?: string;
};
