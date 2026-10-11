import { request } from '../../request';
import type { OrganizationMembershipResponse } from '../../responses/organization.response';

export const getMyOrganizations = async (
  signal?: AbortSignal,
): Promise<OrganizationMembershipResponse[]> => {
  const response = await request.get('/v1/organizations', { signal });
  return response.data.data.organizations as OrganizationMembershipResponse[];
};
