FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

# Install build tools
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

# Copy clean source
COPY . .

# Build shared first, then web
RUN npm run build -w @open-inspect/shared
ENV NODE_ENV=production
ENV NEXT_PUBLIC_WS_URL=wss://ramp.beenex.org
RUN npm run build -w @open-inspect/web

# Production runner
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

# Copy standalone build
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

EXPOSE 3000

CMD ["node", "packages/web/server.js"]
