export class CatalogApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Ответ сервера превышает допустимый размер.');
  }
  if (!response.body) throw new Error('Пустой ответ сервера.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES)
        throw new Error('Ответ сервера превышает допустимый размер.');
      chunks.push(value);
    }
    return JSON.parse(
      Buffer.concat(chunks, length).toString('utf8'),
    ) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function requestCatalogApi(
  apiUrl: string,
  accessToken: string,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (
    !/^\/v1\/(?:pos\/catalog\/(?:sync-start|page|changes)(?:\?|$)|auth\/context$|users\/me$)/.test(
      path,
    )
  )
    throw new Error('Недопустимый запрос каталога.');
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(5000);
  let response: Response;
  try {
    response = await fetcher(`${apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error(
      timeout.aborted
        ? 'Сервер не ответил за 5 секунд.'
        : `Не удалось подключиться к ${new URL(apiUrl).origin}. Сохранённый каталог остаётся доступен.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await readJson(response);
  } catch (error) {
    signal.throwIfAborted();
    if (response.ok) {
      if (timeout.aborted)
        throw new Error('Сервер не закончил передачу за 5 секунд.');
      if (error instanceof SyntaxError)
        throw new Error('Сервер вернул некорректный JSON.');
      throw error;
    }
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const details =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    const header = response.headers.get('retry-after');
    const delay = header
      ? /^\d+(?:\.\d+)?$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - Date.now()
      : 0;
    const bodyDelay =
      typeof details.retry_after_seconds === 'number'
        ? details.retry_after_seconds * 1000
        : 0;
    const retryAfterMs = Math.min(
      86_400_000,
      Math.max(
        0,
        Number.isFinite(delay) ? delay : 0,
        Number.isFinite(bodyDelay) ? bodyDelay : 0,
      ),
    );
    throw new CatalogApiError(
      response.status,
      typeof details.error_code === 'string'
        ? details.error_code
        : 'CATALOG_API_ERROR',
      response.status === 401
        ? 'Нужно обновить авторизацию.'
        : response.status === 403
          ? 'Доступ к каталогу запрещён.'
          : `Сервер отклонил запрос каталога (HTTP ${response.status}).`,
      retryAfterMs,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('data' in parsed) ||
    !parsed.data ||
    typeof parsed.data !== 'object'
  )
    throw new Error('В ответе сервера отсутствует каталог.');
  return parsed.data;
}
