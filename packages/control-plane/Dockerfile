FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/control-plane/package.json ./packages/control-plane/

# Install dependencies
RUN npm ci --workspace=@open-inspect/shared --workspace=@open-inspect/control-plane

# Copy source files
COPY packages/shared ./packages/shared
COPY packages/control-plane ./packages/control-plane
COPY terraform/d1/migrations ./terraform/d1/migrations

# Build packages
RUN npm run build -w @open-inspect/shared
RUN npm run build:node -w @open-inspect/control-plane

# Production runner
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data

# Install runtime sqlite/ca-certs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy node_modules from builder (for native better-sqlite3 bindings)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY --from=builder /app/packages/control-plane/dist/server.cjs ./dist/server.cjs
COPY --from=builder /app/terraform/d1/migrations ./terraform/d1/migrations

# Create volume dir
RUN mkdir -p /data

EXPOSE 8787

VOLUME ["/data"]

CMD ["node", "dist/server.cjs"]
