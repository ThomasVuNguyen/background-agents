FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

# Install build tools for native addons (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package manifests for workspace resolution
COPY package.json package-lock.json ./
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/github-bot/package.json ./packages/github-bot/
COPY packages/linear-bot/package.json ./packages/linear-bot/
COPY packages/opencomputer-infra/package.json ./packages/opencomputer-infra/
COPY packages/shared/package.json ./packages/shared/
COPY packages/slack-bot/package.json ./packages/slack-bot/
COPY packages/web/package.json ./packages/web/

# Install dependencies with build tools
RUN npm ci

# Copy full repository source
COPY . .

# 1. Build shared
RUN npm run build -w @open-inspect/shared

# 2. Build control-plane
RUN npm run build:node -w @open-inspect/control-plane

# 3. Build web Next.js standalone
ENV NODE_ENV=production
ENV NEXT_PUBLIC_WS_URL=wss://ramp.beenex.org
RUN npm run build -w @open-inspect/web

# Production runner
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV NEXT_TELEMETRY_DISABLED=1

# Install runtime sqlite/ca-certs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy node_modules & control-plane artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY --from=builder /app/packages/control-plane/dist/server.cjs ./dist/server.cjs
COPY --from=builder /app/terraform/d1/migrations ./terraform/d1/migrations

# Copy web standalone artifacts
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

# Copy entrypoint gateway
COPY entrypoint.cjs ./entrypoint.cjs

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "entrypoint.cjs"]
