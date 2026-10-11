import type { DiagnosticProfile, NetworkAdapter } from './diagnostics';

export type CatalogScope = {
  apiUrl: string;
  userId: string;
  membershipId: string;
  organizationId: string;
  storeId: string;
  storeName: string;
};

export type ScaleBarcodeProfile = {
  format: 'ean13-weight-v1';
  prefix: string | null;
  enabled: boolean;
  blocked_reason: 'barcode_conflict' | null;
};

export type CatalogProduct = {
  id: string;
  organization_id: string;
  store_id: string;
  name: string;
  scale_name: string | null;
  scale_plu: number | null;
  barcode: string;
  unit: 'kg';
  retail_price: string | null;
  is_active: boolean;
  updated_at: string;
};

export type ScaleDevice = DiagnosticProfile & {
  nameEncoding: 'ascii' | 'windows-1251';
  barcodePrefix: string;
  setupConfirmed: boolean;
};

export type UploadItemState =
  'pending' | 'in_flight' | 'acknowledged' | 'rejected' | 'uncertain';

export type UploadItem = {
  product: CatalogProduct;
  packetHex: string;
  state: UploadItemState;
  error: string | null;
};

export type UploadEvent = {
  at: string;
  phase: string;
  kind: 'tx' | 'rx' | 'error';
  hex?: string;
  message?: string;
};

export type UploadJob = {
  id: string;
  scope: CatalogScope;
  device: ScaleDevice;
  catalogSyncedAt: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  items: UploadItem[];
  events: UploadEvent[];
  error: string | null;
  disconnectError: string | null;
};

export type ClearPluJob = {
  id: string;
  scope: CatalogScope;
  device: ScaleDevice;
  createdAt: string;
  finishedAt: string | null;
  status: UploadJob['status'];
  commandState: UploadItemState;
  events: UploadEvent[];
  error: string | null;
  disconnectError: string | null;
};

export type ClearPluConfirmation = {
  token: string;
  device: ScaleDevice;
  expiresAt: string;
};

export type CatalogSyncState = {
  running?: boolean;
  phase: 'idle' | 'pages' | 'changes' | 'error' | 'cancelled';
  loaded: number;
  lastSyncedAt: string | null;
  error: string | null;
};

export type CatalogState = {
  scope: CatalogScope | null;
  access: 'none' | 'online' | 'offline';
  accessExpiresAt: string | null;
  sync: CatalogSyncState;
  profile: ScaleBarcodeProfile | null;
  device: ScaleDevice | null;
  total: number;
  latestUpload: UploadJob | null;
  latestClear: ClearPluJob | null;
  error: string | null;
};

export type CatalogRow = CatalogProduct & { issues: string[] };
export type CatalogPage = { products: CatalogRow[]; total: number };
export type UploadPreview = {
  revision: string;
  uncertainCount: number;
  ready: CatalogProduct[];
  excluded: Array<{ id: string; name: string; issues: string[] }>;
  removalRequired: Array<{ id: string; name: string; plu: number }>;
  blockers: string[];
  catalogSyncedAt: string | null;
};

export type CatalogRequest =
  | { type: 'state' }
  | { type: 'connect'; accessToken: string }
  | { type: 'disconnect' }
  | { type: 'list'; search: string; offset: number }
  | { type: 'sync' }
  | { type: 'cancel-sync' }
  | { type: 'save-device'; device: ScaleDevice }
  | { type: 'preview'; productIds?: string[] }
  | {
      type: 'upload';
      productIds?: string[];
      confirmUncertain: boolean;
      revision: string;
    }
  | { type: 'cancel-upload' }
  | { type: 'prepare-clear' }
  | { type: 'clear-products'; token: string }
  | { type: 'cancel-clear' }
  | { type: 'export-clear' }
  | { type: 'adapters' }
  | { type: 'export-upload' };

export type CatalogResultMap = {
  state: CatalogState;
  connect: CatalogState;
  disconnect: CatalogState;
  list: CatalogPage;
  sync: CatalogState;
  'cancel-sync': CatalogState;
  'save-device': CatalogState;
  preview: UploadPreview;
  upload: CatalogState;
  'cancel-upload': CatalogState;
  'prepare-clear': ClearPluConfirmation;
  'clear-products': CatalogState;
  'cancel-clear': CatalogState;
  'export-clear': string | null;
  adapters: NetworkAdapter[];
  'export-upload': string | null;
};

export type CatalogApi = {
  request<T extends CatalogRequest>(
    request: T,
  ): Promise<CatalogResultMap[T['type']]>;
  onChange(listener: () => void): () => void;
  onRefreshRequired(listener: () => void): () => void;
};

export const emptyCatalogState = (): CatalogState => ({
  scope: null,
  access: 'none',
  accessExpiresAt: null,
  sync: { phase: 'idle', loaded: 0, lastSyncedAt: null, error: null },
  profile: null,
  device: null,
  total: 0,
  latestUpload: null,
  latestClear: null,
  error: null,
});
