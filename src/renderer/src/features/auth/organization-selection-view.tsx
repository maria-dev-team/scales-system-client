import { Building2, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { OrganizationMembershipResponse } from '@renderer/common/api/responses/organization.response';
import { AuthShell } from '@renderer/common/components/auth-shell';
import { Button } from '@renderer/common/components/ui/button';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';

type OrganizationSelectionViewProps = {
  memberships: OrganizationMembershipResponse[];
  isLoading: boolean;
  error: unknown;
  pendingId: string | null;
  disabled: boolean;
  onSelect: (membershipId: string) => void;
  onRetry: () => void;
  footer: ReactNode;
};

export function OrganizationSelectionView({
  memberships,
  isLoading,
  error,
  pendingId,
  disabled,
  onSelect,
  onRetry,
  footer,
}: OrganizationSelectionViewProps) {
  const availableMemberships = memberships.filter(
    (membership) =>
      membership.status === 'ACTIVE' && membership.organization !== null,
  );
  const isDisabled = disabled || isLoading || pendingId !== null;

  return (
    <AuthShell
      description="Выберите организацию для работы с весами"
      title="Выберите организацию"
    >
      <div className="space-y-4">
        {isLoading ? (
          <p
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
            Загружаем организации…
          </p>
        ) : null}
        {error ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-destructive" role="alert">
              {getHttpErrorMessage(error)}
            </p>
            <Button
              className="w-full"
              disabled={isDisabled}
              onClick={onRetry}
              type="button"
              variant="ghost"
            >
              Повторить
            </Button>
          </div>
        ) : null}
        {!isLoading && availableMemberships.length > 0 ? (
          <div className="space-y-3">
            {availableMemberships.map((membership) => (
              <button
                aria-busy={pendingId === membership.membership_id}
                className="flex w-full items-center gap-4 rounded-xl border border-border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50"
                disabled={isDisabled}
                key={membership.membership_id}
                onClick={() => onSelect(membership.membership_id)}
                type="button"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                  {pendingId === membership.membership_id ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-5 animate-spin"
                    />
                  ) : (
                    <Building2 aria-hidden="true" className="size-5" />
                  )}
                </span>
                <span className="min-w-0 break-words">
                  <span className="block font-semibold text-card-foreground">
                    {membership.organization!.name}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {membership.position?.name ?? 'Должность не назначена'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {!isLoading && !error && availableMemberships.length === 0 ? (
          <p className="rounded-xl bg-muted p-5 text-center text-sm text-muted-foreground">
            Нет доступных организаций
          </p>
        ) : null}
        {!isLoading && pendingId !== null ? (
          <p
            className="text-center text-sm text-muted-foreground"
            role="status"
          >
            Выбираем организацию…
          </p>
        ) : null}
      </div>
      <div className="mt-6">{footer}</div>
    </AuthShell>
  );
}
