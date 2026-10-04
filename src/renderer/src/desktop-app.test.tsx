import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticState, DiagnosticsApi } from '../../shared/diagnostics';
import DesktopApp from './desktop-app';

const mariaLoaded = vi.hoisted(() => vi.fn());
vi.mock('./bootstrap', () => {
  mariaLoaded();
  return { default: () => <div>Maria loaded</div> };
});

let state: DiagnosticState;
let api: DiagnosticsApi;

beforeEach(() => {
  state = {
    profile: null,
    profileError: null,
    interfaces: [
      {
        name: 'Ethernet',
        address: '192.168.1.2',
        netmask: '255.255.255.0',
        mac: '00:00:00:00:00:01',
      },
    ],
    testProduct: {
      name: 'TEST APPLE',
      lfCode: '900001',
      code: '0000900001',
      pricePerKg: '12.34',
      unit: 'kg',
    },
    run: {
      schemaVersion: 1,
      id: 'run-1',
      startedAt: '2026-10-04T10:00:00Z',
      finishedAt: '2026-10-04T10:00:01Z',
      status: 'completed',
      profile: null,
      testProduct: {
        name: 'TEST APPLE',
        lfCode: '900001',
        code: '0000900001',
        pricePerKg: '12.34',
        unit: 'kg',
      },
      steps: [
        {
          id: 'environment',
          title: 'Окружение',
          status: 'passed',
          summary: 'Windows x64',
        },
        {
          id: 'reachability',
          title: 'Доступность IP',
          status: 'skipped',
          summary: 'Не выполнено: требуется IP',
        },
      ],
      reportDirectory: 'C:\\logs\\run-1',
      persistenceError: null,
      protocolStatus: 'unverified',
    },
  };
  api = {
    getState: vi.fn(async () => state),
    saveProfile: vi.fn(async (profile) => {
      state = {
        ...state,
        profile,
        run: { ...state.run!, status: 'running', profile },
      };
      return state;
    }),
    rerun: vi.fn(async () => {
      state = { ...state, run: { ...state.run!, status: 'running' } };
      return state;
    }),
    cancel: vi.fn(async () => {
      state = { ...state, run: { ...state.run!, status: 'cancelled' } };
      return state;
    }),
    exportReport: vi.fn(async () => ({
      canceled: false,
      path: 'C:\\Desktop\\run-1',
    })),
  };
  Object.defineProperty(window, 'diagnostics', {
    configurable: true,
    value: api,
  });
  vi.stubEnv('VITE_API_URL', '');
  mariaLoaded.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete window.diagnostics;
});

describe('autonomous desktop diagnostics', () => {
  it('opens offline without loading Maria or starting another run on StrictMode mount', async () => {
    render(
      <StrictMode>
        <DesktopApp />
      </StrictMode>,
    );
    expect(await screen.findByText('Windows x64')).toBeVisible();
    expect(screen.getByText('Не выполнено: требуется IP')).toBeVisible();
    expect(screen.getByText('TEST APPLE')).toBeVisible();
    expect(api.rerun).not.toHaveBeenCalled();
    expect(mariaLoaded).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Maria' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Адрес сервера не настроен',
    );
    expect(mariaLoaded).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Диагностика' }));
    expect(await screen.findByText('Windows x64')).toBeVisible();
    expect(api.rerun).not.toHaveBeenCalled();
  });

  it('does not load authentication when the configured API is unavailable', async () => {
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:1');
    render(<DesktopApp />);
    expect(await screen.findByText('Windows x64')).toBeVisible();
    expect(mariaLoaded).not.toHaveBeenCalled();
    expect(api.rerun).not.toHaveBeenCalled();
  });

  it('refreshes an active run without starting it again', async () => {
    vi.useFakeTimers();
    state.run!.status = 'running';
    render(<DesktopApp />);
    await act(async () => {});
    expect(screen.getByText('Проверки выполняются…')).toBeVisible();
    state = { ...state, run: { ...state.run!, status: 'completed' } };
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByText('Проверки завершены')).toBeVisible();
    expect(api.rerun).not.toHaveBeenCalled();
  });

  it('saves the selected connection, controls the run and exports its report', async () => {
    const user = userEvent.setup();
    render(<DesktopApp />);
    await screen.findByText('Windows x64');
    await user.type(screen.getByLabelText('IP весов'), '192.168.1.87');
    await user.selectOptions(
      screen.getByLabelText('Ethernet-адаптер'),
      '192.168.1.2',
    );
    await user.click(
      screen.getByRole('button', { name: 'Сохранить и проверить' }),
    );
    expect(api.saveProfile).toHaveBeenCalledWith({
      scaleIp: '192.168.1.87',
      port: 5001,
      localAddress: '192.168.1.2',
    });
    expect(
      screen.getByRole('button', { name: 'Сохранить и проверить' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    expect(await screen.findByText('Запуск остановлен')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(api.rerun).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Сохранить отчёт' }));
    expect(
      await screen.findByText('Отчёт сохранён: C:\\Desktop\\run-1'),
    ).toBeVisible();
  });

  it('shows persistence, profile and command errors without losing command output', async () => {
    state.profileError = 'Настройки повреждены';
    state.run!.persistenceError = 'Нет места на диске';
    state.run!.steps.push({
      id: 'command',
      title: 'Системные команды',
      status: 'warning',
      summary: 'Команда вернула ошибку',
      commands: [
        {
          executable: 'ipconfig',
          args: ['/all'],
          startedAt: '2026-10-04T10:00:00Z',
          finishedAt: '2026-10-04T10:00:01Z',
          durationMs: 1000,
          stdout: 'Ethernet adapter details',
          stderr: 'Access denied',
          stdoutBase64: 'ZGF0YQ==',
          stderrBase64: '',
          encoding: 'cp866',
          exitCode: 1,
          signal: null,
          timedOut: false,
          cancelled: false,
        },
      ],
    });
    render(<DesktopApp />);
    expect(await screen.findByText(/Нет места на диске/)).toBeVisible();
    expect(screen.getByText(/Настройки повреждены/)).toBeVisible();
    await userEvent.click(screen.getByText('Вывод и подробности'));
    expect(screen.getByText('Ethernet adapter details')).toBeVisible();
    expect(screen.getByText('Access denied')).toBeVisible();
    expect(screen.getByText(/cp866/)).toBeVisible();
  });

  it('keeps an invalid profile editable after main rejects it', async () => {
    vi.mocked(api.saveProfile).mockRejectedValue(
      new Error('Некорректный IPv4'),
    );
    const user = userEvent.setup();
    render(<DesktopApp />);
    await screen.findByText('Windows x64');
    await user.type(screen.getByLabelText('IP весов'), '999.1.2.3');
    await user.selectOptions(
      screen.getByLabelText('Ethernet-адаптер'),
      '192.168.1.2',
    );
    await user.click(
      screen.getByRole('button', { name: 'Сохранить и проверить' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Некорректный IPv4',
    );
    expect(screen.getByLabelText('IP весов')).toHaveValue('999.1.2.3');
    expect(
      screen.getByRole('button', { name: 'Сохранить и проверить' }),
    ).toBeEnabled();
  });

  it('reports a missing Electron bridge instead of waiting indefinitely', async () => {
    delete window.diagnostics;
    render(<DesktopApp />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Запустите установленное приложение',
      ),
    );
  });
});
