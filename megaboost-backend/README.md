# MegaBoost Backend

Backend API and worker runtime for MegaBoost.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:5000/api/health
```

## Manual process start

API process:

```bash
PROCESS_ROLE=api node server.js
```

Worker command process:

```bash
PROCESS_ROLE=worker node src/engine/workerProcessEntry.js
```

Telegram control process:

```bash
PROCESS_ROLE=api node src/telegram/controlProcessEntry.js
```

## Telegram Control

Telegram control is env-token based and only supports existing account control:

- `/status`
- `/pause all`
- `/resume all`
- `/pause <email>`
- `/resume <email>`
- `/help`

Required env vars:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=-5119592058
TELEGRAM_ENABLED=true
TELEGRAM_DEFAULT_USER=dulceva
TELEGRAM_ADMIN_USERNAMES=dulceva
# or TELEGRAM_ADMIN_IDS=123456789
```

Notes:

- Token is read only from env (`TELEGRAM_BOT_TOKEN`) and is not stored in DB.
- Commands are accepted only from the configured `TELEGRAM_CHAT_ID` and authorized users.
- Account scope is restricted to `TELEGRAM_DEFAULT_USER`.
- Basic anti-spam is enabled: max 5 commands per 10 seconds per sender.

Dashboard endpoints:

- `GET /api/admin/telegram` -> `{ enabled, chatId, hasTokenConfigured }`
- `POST /api/admin/telegram` with `{ enabled, chatId }`

PM2 example:

```bash
pm2 start ecosystem.config.cjs --only megaboost-backend,seanboost-telegram
pm2 save
```

This repository intentionally does not include GitHub-based auto-deploy workflows or VPS deploy scripts.
