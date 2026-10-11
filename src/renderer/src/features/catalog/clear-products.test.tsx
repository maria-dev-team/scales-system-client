import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import {
  type CatalogApi,
  type ClearPluJob,
  emptyCatalogState,
} from '../../../../shared/catalog';
import { ClearProducts } from './clear-products';

const device = {
  scaleIp: '192.168.1.8',
  localAddress: '192.168.1.2',
  port: 5001,
  nameEncoding: 'ascii' as const,
  barcodePrefix: '20',
  setupConfirmed: true,
};
const confirmation = {
  token: 'single-use-token',
  device,
  expiresAt: '2099-01-01T00:00:00Z',
};
const request = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (input: { type: string }) =>
    input.type === 'prepare-clear'
      ? confirmation
      : input.type === 'export-clear'
        ? '/reports/clear'
        : emptyCatalogState(),
  );

it('requires reviewing the saved target and explicit confirmation before clearing', async () => {
  const calls = request();
  const browser = userEvent.setup();
  render(
    <ClearProducts
      device={device}
      job={null}
      api={{ request: calls } as unknown as CatalogApi}
      locked={false}
      onState={vi.fn()}
      run={async (action) => action()}
      onNotice={vi.fn()}
    />,
  );
  await browser.click(
    screen.getByRole('button', { name: 'Удалить все товары с весов' }),
  );
  expect(await screen.findByText(/192\.168\.1\.8:5001/)).toBeInTheDocument();
  expect(calls).toHaveBeenCalledTimes(1);
  const confirm = screen.getByRole('button', {
    name: 'Подтвердить удаление всех товаров',
  });
  expect(confirm).toBeDisabled();
  await browser.click(screen.getByRole('checkbox'));
  await browser.click(confirm);
  expect(calls).toHaveBeenCalledWith({
    type: 'clear-products',
    token: confirmation.token,
  });
});

it('closing confirmation never sends a deletion request', async () => {
  const calls = request();
  render(
    <ClearProducts
      device={device}
      job={null}
      api={{ request: calls } as unknown as CatalogApi}
      locked={false}
      onState={vi.fn()}
      run={async (action) => action()}
      onNotice={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Удалить все товары с весов' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }));
  expect(calls.mock.calls.map(([input]) => input.type)).toEqual([
    'prepare-clear',
  ]);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('reports uncertain clearing without claiming success and exports the separate report', async () => {
  const calls = request();
  const notice = vi.fn();
  const job = {
    id: 'job',
    device,
    createdAt: '2026-10-11T00:00:00Z',
    finishedAt: '2026-10-11T00:01:00Z',
    status: 'failed',
    commandState: 'uncertain',
    error: 'Нет ответа весов',
    disconnectError: null,
  } as ClearPluJob;
  render(
    <ClearProducts
      device={device}
      job={job}
      api={{ request: calls } as unknown as CatalogApi}
      locked={false}
      onState={vi.fn()}
      run={async (action) => action()}
      onNotice={notice}
    />,
  );
  expect(
    screen.getByText(/Очистка могла выполниться частично/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Весы подтвердили команды/),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить отчёт об очистке' }),
  );
  await waitFor(() =>
    expect(notice).toHaveBeenCalledWith('Отчёт сохранён: /reports/clear'),
  );
  expect(calls).toHaveBeenCalledWith({ type: 'export-clear' });
});
