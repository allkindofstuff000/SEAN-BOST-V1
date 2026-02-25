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

This repository intentionally does not include GitHub-based auto-deploy workflows or VPS deploy scripts.