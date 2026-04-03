# WhatsApp Automation (Render Deployment)

This repository contains two code paths. Use only `automation-system/` for production deployment.

## Deploy target

- Production app folder: `automation-system/`
- Render config file: `render.yaml`
- Health endpoint after deploy: `/health`

## Quick flow

1. Push this repository to GitHub.
2. Create a Render Web Service using `render.yaml`.
3. Use `starter` plan (always-on, no cold start).
4. Set required environment variables in Render.
5. Deploy and verify `/health`.
6. Open `/login`, sign in with seeded admin credentials.
7. Scan WhatsApp QR once and confirm session is saved.

## Required environment variables (Render)

- `DATABASE_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `SHEET_ID`
- `JWT_SECRET`
- `ADMIN_SEED_EMAIL`
- `ADMIN_SEED_PASSWORD`

For full app details and API routes, see `automation-system/README.md`.
