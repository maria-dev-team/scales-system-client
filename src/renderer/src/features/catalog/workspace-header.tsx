import { ArrowLeft, ArrowLeftRight, Building2, Store } from 'lucide-react';
import type { Ref } from 'react';

import { Button } from '@renderer/common/components/ui/button';

export type WorkspaceSection = 'home' | 'device' | 'catalog';

const titles: Record<WorkspaceSection, string> = {
  home: 'Рабочее место',
  device: 'Настройка весов',
  catalog: 'Каталог товаров',
};
const descriptions: Record<WorkspaceSection, string> = {
  home: 'Обновляйте каталог выбранного магазина и отправляйте товары на весы.',
  device:
    'Укажите параметры подключения и проверьте настройки пробной этикетки.',
  catalog: 'Обновите товары из Maria, проверьте их и отправьте на весы.',
};

export function WorkspaceHeader({
  section,
  organizationName,
  storeName,
  locked,
  onHome,
  onChangeOrganization,
  onChangeStore,
  headingRef,
}: {
  section: WorkspaceSection;
  organizationName?: string;
  storeName: string;
  locked: boolean;
  onHome: () => void;
  onChangeOrganization?: () => void;
  onChangeStore?: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="space-y-6">
      <div className="space-y-2">
        {section !== 'home' ? (
          <Button
            variant="ghost"
            className="mb-1 -ml-3 h-10 px-3 text-sm"
            onClick={onHome}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            На главную
          </Button>
        ) : null}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-3xl font-semibold tracking-tight outline-none"
        >
          {titles[section]}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {descriptions[section]}
        </p>
      </div>
      {section === 'home' ? (
        <section
          aria-label="Текущее рабочее место"
          className={`grid rounded-xl border border-border bg-card ${organizationName || onChangeOrganization ? 'lg:grid-cols-2' : ''}`}
        >
          {organizationName || onChangeOrganization ? (
            <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border p-4 lg:border-r lg:border-b-0">
              <Building2
                aria-hidden="true"
                className="size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1 basis-36">
                <p className="text-xs text-muted-foreground">Организация</p>
                <p className="mt-1 break-words font-semibold">
                  {organizationName || 'Название недоступно'}
                </p>
              </div>
              {onChangeOrganization ? (
                <Button
                  variant="ghost"
                  className="h-10 border-border px-3 text-sm text-foreground"
                  disabled={locked}
                  onClick={onChangeOrganization}
                >
                  <ArrowLeftRight aria-hidden="true" className="size-4" />
                  Сменить организацию
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-3 p-4">
            <Store
              aria-hidden="true"
              className="size-5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1 basis-36">
              <p className="text-xs text-muted-foreground">Магазин</p>
              <p className="mt-1 break-words font-semibold">{storeName}</p>
            </div>
            {onChangeStore ? (
              <Button
                variant="ghost"
                className="h-10 border-border px-3 text-sm text-foreground"
                disabled={locked}
                onClick={onChangeStore}
              >
                <ArrowLeftRight aria-hidden="true" className="size-4" />
                Сменить магазин
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </header>
  );
}
