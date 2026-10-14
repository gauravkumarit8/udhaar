#!/bin/sh
# Container entrypoint: migrate, then run whatever the image was told to run.
#
# Why this exists: the image used to start with `node server.js` and nothing
# else. A host that starts this container (Render, Fly, docker compose) then
# runs whatever code the image carries against whatever schema the database
# happens to have. On 2026-10-14 that produced a live app whose database was
# one migration behind: every loan screen answered 503 until the migration was
# applied by hand. `render.yaml`'s startCommand already migrates for the Render
# service; this makes the container do the same thing wherever it runs.
#
# Failures are loud but not fatal, matching render.yaml: the app starts, and
# /api/health says exactly which column is missing and how to fix it. An app
# that refuses to boot is much harder to diagnose than one that explains itself.
set -u

echo "[entrypoint] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting"

if [ -f ./scripts/migrate-at-boot.mjs ]; then
  node ./scripts/migrate-at-boot.mjs || \
    echo "[entrypoint] migrations did not apply - the app will start and /api/health will explain"
else
  echo "[entrypoint] no migration script in this image - starting without migrating"
fi

exec "$@"
