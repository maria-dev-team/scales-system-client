import axios from 'axios';

const messages = {
  INVALID_CREDENTIALS: 'Неверный email, телефон или пароль.',
  INVALID_SESSION: 'Сессия недействительна. Войдите снова.',
  INVALID_TOKEN: 'Токен недействителен. Войдите снова.',
  TOO_MANY_REQUESTS: 'Слишком много попыток. Попробуйте немного позже.',
};

export const getHttpErrorMessage = (error: unknown): string => {
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === 'AUTH_CONTEXT_CHANGED'
  ) {
    return 'Состояние входа изменилось. Повторите действие.';
  }
  if (!axios.isAxiosError(error))
    return 'Произошла ошибка. Повторите действие.';
  const code: unknown = error.response?.data?.error_code;
  if (typeof code === 'string' && Object.hasOwn(messages, code)) {
    return messages[code as keyof typeof messages];
  }
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return 'Сервер отвечает слишком долго. Проверьте интернет и повторите запрос.';
  }
  if (!error.response) {
    return 'Нет соединения с сервером. Проверьте интернет и повторите запрос.';
  }
  if (error.response.status === 401) return messages.INVALID_CREDENTIALS;
  if (error.response.status === 429) return messages.TOO_MANY_REQUESTS;
  if (error.response.status >= 500) {
    return 'Сервис временно недоступен. Повторите запрос немного позже.';
  }
  return 'Не удалось выполнить запрос. Повторите действие.';
};
