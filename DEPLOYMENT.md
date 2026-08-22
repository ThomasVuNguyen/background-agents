# Deployment Guide — Docker / Coolify

This fork is deployed as Docker containers on a self-hosted server, managed by
[Coolify](https://coolify.io/) PaaS with Traefik for reverse proxying and TLS.

## Architecture

```
Internet → ramp.beenex.org
             │
     ┌───────▼────────┐
     │    Traefik      │  TLS via Let's Encrypt
     │  (via Coolify)  │  entryPoint: websecure
     └───────┬────────┘
             │
     ┌───────▼────────────────────────────────────────┐
     │  entrypoint.cjs — Node.js reverse proxy        │
     │  Port 3000 (exposed)                           │
     │                                                │
     │  /sessions/*, /internal/*, /health → port 8787 │
     │  everything else                  → port 3001  │
     │  WebSocket upgrade: same routing               │
     └───────┬───────────────────┬────────────────────┘
             │                   │
     ┌───────▼──────┐   ┌───────▼──────┐
     │ control-plane│   │     web      │
     │ server.cjs   │   │  Next.js     │
     │ Port 8787    │   │  Port 3001   │
     │ SQLite + ws  │   │  standalone  │
     └──────────────┘   └──────────────┘
             │
             │  WebSocket / HTTPS
             ▼
     ┌──────────────┐
     │  Modal Cloud  │  Sandbox execution
     └──────────────┘
```

## Containers

### Option A: Combined single container (root Dockerfile)

The root `Dockerfile` builds both control-plane and web into one image. The
`entrypoint.cjs` gateway runs both processes and reverse-proxies between them.

```bash
docker build -t open-inspect .
docker run -p 3000:3000 -v openinspect_data:/data open-inspect
```

### Option B: Two separate containers (docker-compose.yaml)

`docker-compose.yaml` runs `control-plane` and `web` as separate services on
the external `coolify` Docker network, with Traefik labels for routing.

```bash
docker compose up -d
```

## Environment Variables

### Required

| Variable | Purpose |
|----------|---------|
| `GITHUB_APP_ID` | GitHub App ID for repo access |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM, `\n` escaped) |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |

### Optional (have defaults)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEPLOYMENT_NAME` | `coolify-lenovo` | Identifier for this deployment |
| `APP_NAME` | `Open-Inspect` | Display name in the UI |
| `SANDBOX_PROVIDER` | `modal` | Sandbox backend (`modal`, `daytona`, `e2b`, etc.) |
| `MODAL_TOKEN_ID` | — | Modal API token ID (required if using Modal) |
| `MODAL_TOKEN_SECRET` | — | Modal API token secret |
| `UNSAFE_ALLOW_ALL_USERS` | `true` | Skip access control (open to all) |
| `WEB_APP_URL` | `https://ramp.beenex.org` | Public URL for the app |
| `NEXT_PUBLIC_WS_URL` | `wss://ramp.beenex.org` | WebSocket URL (baked into client at build time) |

### Encryption keys (auto-generated defaults exist)

| Variable | Purpose |
|----------|---------|
| `TOKEN_ENCRYPTION_KEY` | Encrypts user tokens |
| `REPO_SECRETS_ENCRYPTION_KEY` | Encrypts repo secrets in SQLite |
| `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` | Encrypts provider account credentials |
| `BROWSER_AUTH_SECRET` | Signs auth cookies |
| `SERVICE_AUTH_SECRET_WEB` | Service-to-service auth between web and control-plane |

## Data Persistence

All persistent data lives in the Docker volume mounted at `/data`:

```
/data/
├── open-inspect.db          # SQLite database (replaces Cloudflare D1)
├── sessions/                # Session state files
└── media/                   # Uploaded media (replaces Cloudflare R2)
```

The 65+ SQL migration files from `terraform/d1/migrations/` are applied to SQLite
automatically on startup by `sqlite-adapter.ts`.

> **Warning**: The KV cache (`StandaloneKVNamespace`) is an in-memory `Map` and is
> lost on container restart. This only affects the repo listing cache, which is
> re-populated on the next request.

## How to Deploy

1. Push changes to `ThomasVuNguyen/background-agents` (the `fork` remote)
2. Coolify detects the push and auto-builds the Docker image
3. Containers restart on the server in the `coolify` Docker network
4. Traefik provisions/renews the Let's Encrypt TLS cert for `ramp.beenex.org`

### Manual redeploy

Trigger a rebuild in the Coolify dashboard, or SSH into the server and run:

```bash
docker compose pull && docker compose up -d
```

## How to Change the Domain

1. Update `ramp.beenex.org` in these files:
   - `Dockerfile` (line 34: `NEXT_PUBLIC_WS_URL`)
   - `docker-compose.yaml` (Traefik labels + env vars)
   - `entrypoint.cjs` (fallback defaults)
   - `packages/web/Dockerfile` (line 29: `NEXT_PUBLIC_WS_URL`)
2. Update DNS to point the new domain to your server
3. Redeploy — Traefik will auto-provision a new TLS cert

## Upstream Code (Not Used)

The following upstream artifacts exist in the repo but are **not used** by this
deployment. They are preserved for potential future use and upstream sync:

| Directory/File | What it's for (upstream) |
|---------------|-------------------------|
| `terraform/` | Cloudflare Workers + D1 + KV + R2 infrastructure |
| `.github/workflows/terraform.yml` | Auto-deploy via Terraform on push to main |
| `.github/workflows/deploy-web.yml` | Auto-deploy web to Vercel |
| `packages/slack-bot/` | Slack bot (CF Worker, not deployed in Docker) |
| `packages/github-bot/` | GitHub bot (CF Worker, not deployed in Docker) |
| `packages/linear-bot/` | Linear bot (CF Worker, not deployed in Docker) |
