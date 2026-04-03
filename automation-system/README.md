# Automation System - Production Backend

## Quickstart (Render, no cold start)

1. Push this repository to GitHub.
2. In Render, create service from `render.yaml`.
3. Keep plan as `starter` (always-on; no spin-down).
4. Set required env vars in Render dashboard:
   - `DATABASE_URL`
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `SHEET_ID`
   - `JWT_SECRET`
   - `ADMIN_SEED_EMAIL`
   - `ADMIN_SEED_PASSWORD`
5. Deploy once.
6. Open `https://<your-service>.onrender.com/health`.
7. Open `https://<your-service>.onrender.com/login` and sign in.
8. Open dashboard and scan WhatsApp QR once.

## Progress checks (copy/paste)

- Health:
  - `GET /health`
  - Expect: `database.ok=true`
  - Expect: `whatsapp.hasQr=true` before scan, then `whatsapp.ready=true` after scan.
- Queue + runtime summary:
  - `GET /admin/status`
- Session restore readiness:
  - `GET /admin/session-check`
  - Expect: `healthy=true` after first session backup.

If `/health` returns `database.ok=false`, check `DATABASE_URL` first.

## Architecture

```text
Google Sheets -> Scheduler -> PostgreSQL -> Message Queue -> WhatsApp Worker -> Message Logs
                                           ^
                                           |
                              RemoteAuth Session Store (PostgreSQL)
```

## Updated backend structure

```text
automation-system/
  backend/
    api/
      server.js
    database/
      db.js
      schema.sql
    scheduler/
      cronJobs.js
    services/
      sheetsService.js
      reminderService.js
      messageService.js
      queueService.js
    whatsapp/
      whatsappClient.js
      postgresSessionStore.js
      sendMessage.js
    worker/
      messageWorker.js
    app.js
    testSend.js
  .env
  .gitignore
  package.json
```

## Key production features

- Persistent WhatsApp auth using `whatsapp-web.js` `RemoteAuth`.
- Session zip stored in PostgreSQL table `whatsapp_sessions`.
- Automatic session restoration on restart.
- Queue-first reminder workflow using `message_queue`.
- Sequential sender worker to reduce ban/rate risk.
- Duplicate prevention by `(phone, reminder_date)` queue key and sent-today check.
- Admin recovery endpoint: `POST /admin/reconnect`.

## Node runtime

- Use Node 20 LTS for production stability.
- Project pin: `engines.node: >=20 <21`.
- `.nvmrc` is set to `20`.

## Environment variables

`.env`:

- `DATABASE_URL=...`
- `GOOGLE_SERVICE_ACCOUNT=../service-account.json`
- `SHEET_ID=...`
- `SHEET_RANGE=Sheet1!A:E`
- `WHATSAPP_SESSION_PATH=./sessions`
- `WHATSAPP_CLIENT_ID=default`
- `WHATSAPP_REMOTE_BACKUP_INTERVAL_MS=300000`
- `PUPPETEER_HEADLESS=true`
- `CRON_SCHEDULE=0 9 * * *`
- `APP_TIMEZONE=Asia/Kolkata`
- `WORKER_POLL_INTERVAL_MS=5000`
- `MAX_SEND_RETRIES=3`
- `API_PORT=3000`

## Install and run

```bash
cd automation-system
npm install
npm start
```

## First-time authentication flow

1. Start backend.
2. Check `GET /health`.
3. If `whatsapp.hasQr=true`, retrieve QR from:
   - console logs, or
   - `GET /admin/qr`
4. Scan QR once as admin.
5. Session is saved into `whatsapp_sessions`.
6. Future restarts auto-restore without QR.

## Admin endpoints

- `GET /health`
- `GET /admin/status`
- `GET /admin/session-check`
- `GET /admin/qr`
- `POST /admin/run-now` (sheet sync + enqueue + immediate worker pass)
- `POST /admin/reconnect` (force session reset and generate new QR)

## Test send

```bash
npm run test:send -- +919486655791
```

## Render deployment notes

1. Deploy `automation-system` as a Web Service.
2. Set build command: `npm install`.
3. Set start command: `npm start`.
4. Set all `.env` values in Render environment settings.
5. Set Node runtime to 20.x.
6. Keep `PUPPETEER_HEADLESS=true`.
7. On first deployment, open logs and scan QR once.
8. Confirm `GET /health` shows `whatsapp.ready=true`.
9. Confirm `GET /admin/session-check` returns `healthy=true` before restart tests.

## Security

Keep these ignored from git:

- `.env`
- `service-account.json`
- `sessions/`
