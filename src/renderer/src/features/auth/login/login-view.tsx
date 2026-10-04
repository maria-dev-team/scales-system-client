import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { login } from '@renderer/common/api';
import { AuthShell } from '@renderer/common/components/auth-shell';
import { Button } from '@renderer/common/components/ui/button';
import { FormField } from '@renderer/common/components/ui/form-field';
import { Input } from '@renderer/common/components/ui/input';
import { Label } from '@renderer/common/components/ui/label';
import { queryKeys } from '@renderer/common/constants/query-keys';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';

import { useAuthStore } from '../stores/auth-store';
import { type LoginValues, loginSchema } from './login.schema';

type LoginErrors = Partial<Record<keyof LoginValues, string>>;
type TouchedFields = Partial<Record<keyof LoginValues, boolean>>;

const getValidationErrors = (values: LoginValues): LoginErrors => {
  const result = loginSchema.safeParse(values);
  if (result.success) return {};
  return result.error.issues.reduce<LoginErrors>((errors, issue) => {
    const field = issue.path[0];
    if ((field === 'login' || field === 'password') && !errors[field]) {
      errors[field] = issue.message;
    }
    return errors;
  }, {});
};

export function LoginView() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<LoginValues>({
    login: '',
    password: '',
  });
  const [errors, setErrors] = useState<LoginErrors>({});
  const [touched, setTouched] = useState<TouchedFields>({});
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: (result) => {
      queryClient.setQueryData(
        queryKeys.auth.currentUser(useAuthStore.getState().authGeneration),
        result.user,
      );
    },
  });

  const updateValue = (field: keyof LoginValues, value: string): void => {
    const nextValues = { ...values, [field]: value };
    setValues(nextValues);
    if (mutation.isError) mutation.reset();
    if (touched[field]) {
      setErrors((current) => ({
        ...current,
        [field]: getValidationErrors(nextValues)[field],
      }));
    }
  };

  const touchField = (field: keyof LoginValues): void => {
    setTouched((current) => ({ ...current, [field]: true }));
    setErrors((current) => ({
      ...current,
      [field]: getValidationErrors(values)[field],
    }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (mutation.isPending) return;
    const validationErrors = getValidationErrors(values);
    setTouched({ login: true, password: true });
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    mutation.mutate(loginSchema.parse(values));
  };

  const passwordToggleLabel = isPasswordVisible
    ? 'Скрыть пароль'
    : 'Показать пароль';

  return (
    <AuthShell
      description="Введите данные своей учётной записи"
      title="Вход в DukenAI Scales"
    >
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <FormField>
          <Label htmlFor="login">Email или телефон</Label>
          <Input
            aria-describedby={errors.login ? 'login-message' : undefined}
            aria-invalid={Boolean(errors.login)}
            autoComplete="username"
            disabled={mutation.isPending}
            id="login"
            name="login"
            onBlur={() => touchField('login')}
            onChange={(event) => updateValue('login', event.target.value)}
            placeholder="name@company.kz или +7 777 000 00 00"
            type="text"
            value={values.login}
          />
          {errors.login ? (
            <p
              aria-live="polite"
              className="px-1 text-xs text-destructive"
              id="login-message"
            >
              {errors.login}
            </p>
          ) : null}
        </FormField>
        <FormField>
          <Label htmlFor="password">Пароль</Label>
          <div className="relative">
            <Input
              aria-describedby={
                errors.password ? 'password-message' : undefined
              }
              aria-invalid={Boolean(errors.password)}
              autoComplete="current-password"
              className="pr-14"
              disabled={mutation.isPending}
              id="password"
              name="password"
              onBlur={() => touchField('password')}
              onChange={(event) => updateValue('password', event.target.value)}
              placeholder="••••••••"
              type={isPasswordVisible ? 'text' : 'password'}
              value={values.password}
            />
            <Button
              aria-label={passwordToggleLabel}
              aria-pressed={isPasswordVisible}
              className="absolute inset-y-0 right-1 my-auto active:translate-y-0"
              onClick={() => setIsPasswordVisible((current) => !current)}
              size="icon"
              title={passwordToggleLabel}
              type="button"
              variant="ghost"
            >
              {isPasswordVisible ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
            </Button>
          </div>
          {errors.password ? (
            <p
              aria-live="polite"
              className="px-1 text-xs text-destructive"
              id="password-message"
            >
              {errors.password}
            </p>
          ) : null}
        </FormField>
        {mutation.isError ? (
          <p className="text-sm leading-6 text-destructive" role="alert">
            {getHttpErrorMessage(mutation.error)}
          </p>
        ) : null}
        <Button
          className="mt-2 w-full rounded-lg font-semibold"
          disabled={mutation.isPending}
          type="submit"
        >
          {mutation.isPending ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : null}
          Войти
        </Button>
      </form>
    </AuthShell>
  );
}
