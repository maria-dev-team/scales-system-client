export type PositionResponse = {
  created_at: string;
  deleted_at: string | null;
  id: string;
  is_system: boolean;
  name: string;
  organization_id: string;
  permissions: string[];
  updated_at: string;
};

export type OrganizationResponse = {
  address: string | null;
  bin_iin: string | null;
  created_at: string;
  default_currency: string;
  deleted_at: string | null;
  id: string;
  language: string;
  legal_form: string;
  legal_name: string;
  name: string;
  timezone: string;
  trade_name: string | null;
  updated_at: string;
};

export type OrganizationMembershipResponse = {
  membership_id: string;
  organization: OrganizationResponse | null;
  position: PositionResponse | null;
  status: 'ACTIVE' | 'SUSPENDED';
};
