# Deploying Bisquits to Google Cloud Run

This project can be deployed as a single Cloud Run service:
- Colyseus server (`/matchmake` + websocket transport)
- Built client bundle (`dist/client`) served by `server/index.ts`

## Prerequisites

- Google Cloud project with billing enabled.
- `gcloud` CLI installed and authenticated.
- Required IAM roles (at minimum):
  - Cloud Run Admin
  - Cloud Build Editor
  - Service Account User

## One-time setup

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
```

## Deploy (recommended)

From repo root:

```bash
PROJECT_ID=<PROJECT_ID> REGION=us-central1 pnpm deploy:cloudrun
```

Optional env overrides:

```bash
PROJECT_ID=<PROJECT_ID> \
REGION=us-central1 \
SERVICE_NAME=bisquits \
ALLOW_UNAUTHENTICATED=true \
BISQUITS_RESERVATION_SECONDS=300 \
BISQUITS_ACTION_LOG_LIMIT=120 \
pnpm deploy:cloudrun
```

The deploy script uses:

```bash
gcloud run deploy <SERVICE_NAME> --source .
```

with the included `Dockerfile`.

## Notes for multiplayer

- Cloud Run sets `PORT`; the server now honors `PORT` automatically.
- Client websocket endpoint defaults to same-origin in production, and `:2567` when running on Vite local ports.
- Websocket connections on Cloud Run are supported, but Cloud Run request timeout still applies (max 60 min). Reconnect handling is still required.
- Current stats storage uses local filesystem (`server/data/stats.json`), which is not durable on Cloud Run instances. For production persistence, move stats to Firestore or Cloud SQL.

## Verify

1. Open the Cloud Run URL in two browser windows.
2. Create a room in one window and join from the other.
3. Start a game and verify tile sync + reconnect behavior.

## Troubleshooting

- If deploy fails on IAM/API permissions, re-run with the right roles and ensure these APIs are enabled:
  - `run.googleapis.com`
  - `cloudbuild.googleapis.com`
  - `artifactregistry.googleapis.com`
- If local dev no longer connects, set `VITE_COLYSEUS_URL` explicitly.
