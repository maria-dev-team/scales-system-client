import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DesktopApp from './desktop-app';

const mariaLoaded = vi.hoisted(() => vi.fn());
vi.mock('./bootstrap', () => {
  mariaLoaded();
  return {
    default: () => (
      <main>
        <h1>Maria loaded</h1>
        <input aria-label="Рабочее поле Maria" defaultValue="" />
      </main>
    ),
  };
});

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', '');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
  mariaLoaded.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('desktop shell', () => {
  it('shows server setup and application status without loading Maria when the API is unconfigured', () => {
    render(
      <StrictMode>
        <DesktopApp />
      </StrictMode>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Адрес сервера не настроен',
    );
    expect(screen.getByRole('heading', { name: 'Вход в Maria' })).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(mariaLoaded).not.toHaveBeenCalled();
    expect(
      screen.getByRole('banner', { name: 'Статус приложения' }),
    ).toBeVisible();
    expect(
      screen.getByRole('status', { name: 'Сервер не настроен' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Текущее время')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Диагностика' }),
    ).not.toBeInTheDocument();
  });

  it('keeps Maria usable when the configured API is offline', async () => {
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:1');
    const user = userEvent.setup();
    render(<DesktopApp />);
    expect(await screen.findByText('Maria loaded')).toBeVisible();
    expect(
      await screen.findByRole('status', { name: 'Нет связи с сервером' }),
    ).toBeVisible();
    const field = screen.getByLabelText('Рабочее поле Maria');
    await user.type(field, 'Выбранный магазин');
    expect(field).toBeVisible();
    expect(field).toHaveValue('Выбранный магазин');
    expect(
      screen.getByRole('banner', { name: 'Статус приложения' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Диагностика' }),
    ).not.toBeInTheDocument();
  });
});
