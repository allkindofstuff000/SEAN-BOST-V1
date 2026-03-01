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

Telegram control uses one group panel message and only pause/resume actions.

Group commands:

- `/start` or `/panel` -> create/update one control panel message in the configured group

Panel buttons (inline keyboard only):

- `Pause` (`pause_one`)
- `Resume` (`resume_one`)
- `Pause all` (`pause_all`)
- `Resume all` (`resume_all`)

Single-account actions open an inline account picker (first 10 accounts), then execute:

- `pause:{accountId}`
- `resume:{accountId}`

Settings are stored in MongoDB collection `TelegramSettings`:

- `botToken`
- `chatId`
- `panelMessageId`
- `updatedAt`

Security and behavior:

- Bot accepts actions only from the configured `chatId`.
- Other chats get `Not authorized.`.
- Callback actions use a 2-second per-chat cooldown.
- Panel message is edited in-place (no message spam), and stats refresh after each action.

API endpoints:

- `GET /api/settings/telegram`
- `POST /api/settings/telegram` with `{ botToken, chatId }`
- `POST /api/settings/telegram/panel` (force panel refresh)

Telegram process:

```bash
PROCESS_ROLE=api node src/telegram/controlProcessEntry.js
```

PM2 example:

```bash
pm2 start ecosystem.config.cjs --only megaboost-backend,seanboost-telegram
pm2 save
```

This repository intentionally does not include GitHub-based auto-deploy workflows or VPS deploy scripts.
