import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  type CatalogState,
  emptyCatalogState,
} from '../../../../shared/catalog';
import { WorkspaceHome } from './workspace-home';

const saved = (): CatalogState => ({
  ...emptyCatalogState(),
  access: 'online',
  total: 12,
  sync: {
    phase: 'idle',
    loaded: 12,
    lastSyncedAt: '2026-10-11T08:30:00Z',
    error: null,
  },
  profile: {
    format: 'ean13-weight-v1',
    prefix: '22',
    enabled: true,
    blocked_reason: null,
  },
  device: {
    scaleIp: '192.168.1.87',
    port: 5001,
    localAddress: '192.168.1.89',
    nameEncoding: 'windows-1251',
    barcodePrefix: '22',
    setupConfirmed: true,
  },
});

describe('workspace home', () => {
  it('withholds cached details and actions while access is being checked', () => {
    render(
      <WorkspaceHome
        state={{ ...saved(), access: 'none' }}
        onOpenDevice={() => {}}
        onOpenCatalog={() => {}}
      />,
    );
    expect(screen.getAllByText('Проверяем доступ')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Настроить весы' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Открыть каталог' }),
    ).toBeDisabled();
    expect(screen.queryByText('192.168.1.87:5001')).not.toBeInTheDocument();
    expect(screen.queryByText('12')).not.toBeInTheDocument();
  });

  it('opens the requested section and describes confirmed settings without claiming a live connection', async () => {
    const onOpenDevice = vi.fn();
    const onOpenCatalog = vi.fn();
    render(
      <WorkspaceHome
        state={saved()}
        onOpenDevice={onOpenDevice}
        onOpenCatalog={onOpenCatalog}
      />,
    );
    expect(screen.getByText('Настройки подтверждены')).toBeVisible();
    expect(screen.getByText('192.168.1.87:5001')).toBeVisible();
    expect(
      screen.getByText('Связь с весами проверяется при отправке товаров.'),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Настроить весы' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Открыть каталог' }),
    );
    expect(onOpenDevice).toHaveBeenCalledOnce();
    expect(onOpenCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'Профиль Maria ещё не получен',
      (state: CatalogState): void => {
        state.profile = null;
      },
    ],
    [
      'Нет сохранённых настроек',
      (state: CatalogState): void => {
        state.device = null;
      },
    ],
    [
      'Нужна проверка этикетки',
      (state: CatalogState): void => {
        state.device!.setupConfirmed = false;
      },
    ],
    [
      'Префикс не совпадает',
      (state: CatalogState): void => {
        state.profile!.prefix = '23';
      },
    ],
    [
      'Профиль Maria отключён',
      (state: CatalogState): void => {
        state.profile!.enabled = false;
      },
    ],
    [
      'Конфликт штрихкодов',
      (state: CatalogState): void => {
        state.profile!.blocked_reason = 'barcode_conflict';
      },
    ],
  ] as const)('shows %s instead of ready configuration', (label, change) => {
    const state = saved();
    change(state);
    render(
      <WorkspaceHome
        state={state}
        onOpenDevice={() => {}}
        onOpenCatalog={() => {}}
      />,
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(
      screen.queryByText('Настройки подтверждены'),
    ).not.toBeInTheDocument();
  });

  it('distinguishes an unfinished first sync from a saved empty catalog', () => {
    const state = {
      ...saved(),
      total: 0,
      sync: {
        phase: 'pages' as const,
        running: false,
        loaded: 7,
        lastSyncedAt: null,
        error: null,
      },
    };
    const { rerender } = render(
      <WorkspaceHome
        state={state}
        onOpenDevice={() => {}}
        onOpenCatalog={() => {}}
      />,
    );
    expect(screen.getByText('Ожидает продолжения')).toBeVisible();
    expect(screen.queryByText('Каталог пуст')).not.toBeInTheDocument();
    rerender(
      <WorkspaceHome
        state={{ ...saved(), total: 0 }}
        onOpenDevice={() => {}}
        onOpenCatalog={() => {}}
      />,
    );
    expect(screen.getByText('Каталог пуст')).toBeVisible();
  });

  it('keeps saved count and timestamp visible offline without promising current prices', () => {
    render(
      <WorkspaceHome
        state={{ ...saved(), access: 'offline' }}
        disabled
        onOpenDevice={() => {}}
        onOpenCatalog={() => {}}
      />,
    );
    expect(screen.getByText('Сохранённая копия')).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    expect(screen.getByText(/Цены могли измениться/)).toBeVisible();
    expect(document.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-10-11T08:30:00Z',
    );
    expect(
      screen.getByRole('button', { name: 'Настроить весы' }),
    ).toBeDisabled();
  });
});
