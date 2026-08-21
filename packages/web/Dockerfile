FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/

# Install dependencies
RUN npm ci --workspace=@open-inspect/shared --workspace=@open-inspect/web

# Copy source
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

# Build shared first, then web
RUN npm run build -w @open-inspect/shared
ENV NEXT_TELEMETRY_DISABLED=1
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
