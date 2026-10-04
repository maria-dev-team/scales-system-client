import { z } from 'zod';

export const loginSchema = z.object({
  login: z
    .string()
    .trim()
    .min(1, 'Введите email или телефон')
    .min(2, 'Email или телефон должен содержать не менее 2 символов')
    .max(255, 'Email или телефон должен содержать не более 255 символов'),
  password: z
    .string()
    .min(1, 'Введите пароль')
    .pipe(
      z
        .string()
        .min(8, 'Пароль должен содержать не менее 8 символов')
        .max(255, 'Пароль должен содержать не более 255 символов'),
    ),
});

export type LoginValues = z.infer<typeof loginSchema>;
