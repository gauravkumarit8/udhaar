# ── Stage 1: Build ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Build the Next.js app
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy drizzle schema for migrations
COPY --from=builder /app/src/db ./src/db
COPY --from=builder /app/drizzle.config.json ./
COPY --from=builder /app/node_modules/.package-lock.json ./node_modules/.package-lock.json 2>/dev/null || true

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
