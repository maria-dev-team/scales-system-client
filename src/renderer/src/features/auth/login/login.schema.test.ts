import { describe, expect, it } from 'vitest';

import { loginSchema } from './login.schema';

describe('loginSchema', () => {
  it('accepts an email or phone login', () => {
    const email = loginSchema.safeParse({
      login: 'cashier@maria.kz',
      password: '12345678',
    });
    const phone = loginSchema.safeParse({
      login: '+7 777 123 45 67',
      password: '12345678',
    });

    expect(email.success).toBe(true);
    expect(phone.success).toBe(true);
  });

  it('rejects a password shorter than eight characters', () => {
    const result = loginSchema.safeParse({
      login: 'cashier@maria.kz',
      password: '1234567',
    });

    expect(result.success).toBe(false);
    expect(result.error?.flatten().fieldErrors.password).toContain(
      'Пароль должен содержать не менее 8 символов',
    );
  });

  it('rejects a login shorter than 2 or longer than 255 characters', () => {
    const short = loginSchema.safeParse({ login: 'a', password: '12345678' });
    const result = loginSchema.safeParse({
      login: 'a'.repeat(256),
      password: '12345678',
    });

    expect(short.success).toBe(false);
    expect(short.error?.flatten().fieldErrors.login).toContain(
      'Email или телефон должен содержать не менее 2 символов',
    );
    expect(result.success).toBe(false);
    expect(result.error?.flatten().fieldErrors.login).toContain(
      'Email или телефон должен содержать не более 255 символов',
    );
  });

  it('rejects a password longer than 255 characters', () => {
    const result = loginSchema.safeParse({
      login: 'cashier@maria.kz',
      password: 'p'.repeat(256),
    });

    expect(result.success).toBe(false);
    expect(result.error?.flatten().fieldErrors.password).toContain(
      'Пароль должен содержать не более 255 символов',
    );
  });

  it('accepts a password containing spaces', () => {
    const result = loginSchema.safeParse({
      login: 'cashier@maria.kz',
      password: 'pass word',
    });

    expect(result.success).toBe(true);
  });

  it('trims a valid login', () => {
    const result = loginSchema.safeParse({
      login: '  cashier@maria.kz  ',
      password: '12345678',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.login).toBe('cashier@maria.kz');
  });
});
