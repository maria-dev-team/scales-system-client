import { LoaderCircle, MapPin, Store } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AuthContextResponse } from '@renderer/common/api/responses/auth-context.response';
import { AuthShell } from '@renderer/common/components/auth-shell';
import { Button } from '@renderer/common/components/ui/button';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';

type StoreSelectionViewProps = {
  stores: AuthContextResponse['storeScope']['stores'];
  organizationName?: string;
  isLoading: boolean;
  error: unknown;
  pendingId: string | null;
  disabled: boolean;
  onSelect: (storeId: string) => void;
  onRetry: () => void;
  onBack: () => void;
  footer: ReactNode;
};

export function StoreSelectionView({
  stores,
  organizationName,
  isLoading,
  error,
  pendingId,
  disabled,
  onSelect,
  onRetry,
  onBack,
  footer,
}: StoreSelectionViewProps) {
  const isDisabled = disabled || isLoading || pendingId !== null;

  return (
    <AuthShell
      description={
        organizationName
          ? `${organizationName}. Выберите магазин для работы с весами`
          : 'Выберите магазин для работы с весами'
      }
      title="Выберите магазин"
    >
      <div className="space-y-4">
        {isLoading ? (
          <p
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
            Загружаем магазины…
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
        {!isLoading && stores.length > 0 ? (
          <div className="space-y-3">
            {stores.map((store) => (
              <button
                aria-busy={pendingId === store.id}
                className="flex w-full items-center gap-4 rounded-xl border border-border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50"
                disabled={isDisabled}
                key={store.id}
                onClick={() => onSelect(store.id)}
                type="button"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                  {pendingId === store.id ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-5 animate-spin"
                    />
                  ) : (
                    <Store aria-hidden="true" className="size-5" />
                  )}
                </span>
                <span className="min-w-0 break-words">
                  <span className="block font-semibold text-card-foreground">
                    {store.name}
                  </span>
                  <span className="mt-1 flex items-start gap-1 text-sm text-muted-foreground">
                    <MapPin
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0"
                    />
                    <span>{store.address ?? 'Адрес не указан'}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {!isLoading && !error && stores.length === 0 ? (
          <p className="rounded-xl bg-muted p-5 text-center text-sm text-muted-foreground">
            Нет доступных магазинов
          </p>
        ) : null}
        {!isLoading && pendingId !== null ? (
          <p
            className="text-center text-sm text-muted-foreground"
            role="status"
          >
            Выбираем магазин…
          </p>
        ) : null}
      </div>
      <Button
        className="mt-6 h-auto w-full whitespace-normal"
        disabled={isDisabled}
        onClick={onBack}
        type="button"
        variant="ghost"
      >
        Выбрать другую организацию
      </Button>
      <div className="mt-6">{footer}</div>
    </AuthShell>
  );
}
