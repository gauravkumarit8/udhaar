# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app

# The commit this image was built from. It is reported by /api/health, which is
# how the deploy workflow can tell "the new code is live" apart from "the old
# container is still answering" - the difference that let a release go out
# un-migrated on 2026-10-14.
ARG GIT_SHA=""
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA

# Who may frame the app (the `frame-ancestors` CSP directive). It is read HERE,
# at build time, and baked into the routes manifest - setting it on a running
# container does nothing. The default, "none", means nobody may frame it.
#   docker build --build-arg FRAME_ANCESTORS="'self' https://example.com" .
ARG FRAME_ANCESTORS=""
ENV FRAME_ANCESTORS=$FRAME_ANCESTORS

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# The release this image contains, so a deployed container can name its own
# commit even when the host injects nothing (Render sets RENDER_GIT_COMMIT on
# services it builds itself; a host that merely runs this image does not).
# An empty value is ignored by src/lib/build-info.ts, so an unstamped local
# build still reports "unknown" rather than a blank commit.
ARG GIT_SHA=""
ENV GIT_COMMIT=$GIT_SHA

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy the Drizzle schema, migrations and config so the schema can be applied
# from inside the container, e.g.
#   docker compose run --rm web npm run db:migrate
COPY --from=builder /app/src/db ./src/db
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv
# The boot migration script (and the baseline check it prefers when present),
# so `docker run` applies pending migrations before the server starts.
COPY --from=builder /app/scripts ./scripts

RUN chmod +x ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "./docker-entrypoint.sh"]
CMD ["node", "server.js"]
