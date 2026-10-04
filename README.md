# DukenAI Scales

Electron-приложение для подготовки и загрузки товаров в весы Rongta RLS1100.
Каркас и страница входа перенесены из `pos-system-client`.

Сейчас реализованы вход в Maria, восстановление сессии, отображение учётной
записи и выход. Выбор организации/магазина, локальная БД, каталог и обмен с
весами будут добавлены отдельно.

## Запуск

Используйте Node.js 22 и npm:

```sh
nvm use
npm ci
cp .env.example .env
npm run dev
```

В `.env` задайте `VITE_API_URL` — корневой URL API без `/v1`, например
`http://localhost:4004`. Это публичная настройка сборки, не место для секретов.
После изменения адреса перезапустите dev-сервер или пересоберите приложение.
Для авторизации нужен доступный бэкенд и существующая учётная запись Maria.

Если Electron установлен неполностью, проверьте `node --version`, переключитесь
на Node.js 22 через `nvm use` и повторите `npm ci`.

## Авторизация

Приложение использует существующие `/v1/auth/login`, `/v1/auth/refresh`,
`/v1/auth/logout` и `/v1/users/me`. В login передаётся `client_type: "web"`,
чтобы не зависеть от кассовых смен. Пароль не сохраняется. Access token хранится
в `sessionStorage` под ключом `scales.access-token`, refresh token — в HttpOnly
cookie, которой управляет сервер. Logout очищает состояние после успешного
ответа сервера; ошибка сети оставляет возможность повторить выход.

Production renderer загружается с origin `maria://app`, как в POS. Для входа
сервер должен разрешать этот origin и фактический dev-origin (адрес из вывода
`npm run dev`) в `CORS_ORIGINS` с credentials. Production API использует HTTPS
и совместимые cross-origin refresh-cookie (`SameSite=None; Secure`).
Настройки cookie локального backend-окружения отличаются, поэтому восстановление
входа отдельно проверяется с production-сборкой и целевым API.

На старте приложение проверяет refresh-cookie. Если сервер недоступен, оно
показывает ошибку с повторной попыткой. Вход без сети и автономный доступ к
каталогу в этот этап не входят.

## Проверки и сборка

```sh
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
npm start
```

`npm run build` создаёт `out/`. `npm start` открывает собранное приложение.
`npm run build:win` на Windows создаёт NSIS-установщик x64 в `dist/`.
Workflow Build выполняет проверки и сборку установщика на Windows.
Отдельный workflow Lint проверяет ESLint и форматирование на Ubuntu.
Оба запускаются для PR в `main` или вручную. Dependabot ежемесячно проверяет
обновления npm-зависимостей. Конфигурации и шаблон PR взяты из `pos-system-client`.

## Релизы Windows

Workflow Release Windows собирает и загружает установщик при публикации
GitHub Release. В **Settings → Secrets and variables → Actions → Variables**
задайте `SCALES_API_URL` — корневой HTTPS URL production API без `/v1`.

Создайте релиз из `main` с тегом `vMAJOR.MINOR.PATCH`, например `v0.1.0`, и
опубликуйте его. Workflow возьмёт версию из тега, выполнит проверки и вызовет
`npm run release:win`. Версию в `package.json` перед релизом менять не нужно.
Для загрузки используется встроенный GitHub token с правом `contents: write`.

Постоянный адрес последнего установщика:

```text
https://github.com/maria-dev-team/scales-system-client/releases/latest/download/dukenai-scales-setup.exe
```

Для приватного репозитория скачивание требует авторизации GitHub.
Подпись установщика и автообновление внутри приложения пока не настроены.

Архитектура описана в [ARCHITECTURE.md](./ARCHITECTURE.md).
