#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-bisquits}"
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-}"
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-true}"
BISQUITS_RESERVATION_SECONDS="${BISQUITS_RESERVATION_SECONDS:-300}"
BISQUITS_ACTION_LOG_LIMIT="${BISQUITS_ACTION_LOG_LIMIT:-120}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "PROJECT_ID is required. Example: PROJECT_ID=my-gcp-project pnpm deploy:cloudrun"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID"

cmd=(
  gcloud run deploy "$SERVICE_NAME"
  --source .
  --project "$PROJECT_ID"
  --region "$REGION"
  --port 8080
  --timeout 3600
  --set-env-vars "BISQUITS_RESERVATION_SECONDS=${BISQUITS_RESERVATION_SECONDS},BISQUITS_ACTION_LOG_LIMIT=${BISQUITS_ACTION_LOG_LIMIT}"
)

if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
  cmd+=(--allow-unauthenticated)
fi

"${cmd[@]}"
