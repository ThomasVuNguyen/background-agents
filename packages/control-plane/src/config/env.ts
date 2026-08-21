import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import type { Env } from "../types";
import { createSqliteDatabase } from "../db/sqlite-adapter";
import { FilesystemObjectStorage } from "../storage/filesystem-media-storage";
import { StandaloneKVNamespace } from "../storage/standalone-kv";
import { StandaloneSessionNamespace } from "../session/standalone-session-namespace";
import { installGlobalWebSocketPair } from "../session/standalone-websocket-pair";

export function loadStandaloneEnv(): Env {
  dotenv.config();
  installGlobalWebSocketPair();

  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "open-inspect.db");
  const sessionsDir = path.join(dataDir, "sessions");
  const mediaDir = path.join(dataDir, "media");

  // Locate migrations dir relative to control-plane or monorepo root
  const potentialMigrationDirs = [
    path.join(process.cwd(), "terraform/d1/migrations"),
    path.join(process.cwd(), "../../terraform/d1/migrations"),
    path.join(__dirname, "../../../../terraform/d1/migrations"),
  ];
  let migrationsDir = potentialMigrationDirs[0];
  for (const dir of potentialMigrationDirs) {
    if (fs.existsSync(dir)) {
      migrationsDir = dir;
      break;
    }
  }

  const db = createSqliteDatabase(dbPath, migrationsDir);
  const mediaStorage = new FilesystemObjectStorage(mediaDir);
  const reposCache = new StandaloneKVNamespace();

  let envRef: Env;

  const sessionNamespace = new StandaloneSessionNamespace(
    () => envRef,
    sessionsDir
  );

  const env: Env = {
    SESSION: sessionNamespace as unknown as DurableObjectNamespace,
    REPOS_CACHE: reposCache as unknown as KVNamespace,
    DB: db as unknown as D1Database,
    MEDIA_BUCKET: mediaStorage as unknown as R2Bucket,

    TOKEN_ENCRYPTION_KEY:
      process.env.TOKEN_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY:
      process.env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    REPO_SECRETS_ENCRYPTION_KEY:
      process.env.REPO_SECRETS_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",

    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || "coolify-deployment",
    APP_NAME: process.env.APP_NAME || "Open-Inspect",
    SCM_PROVIDER: process.env.SCM_PROVIDER || "github",
    WORKER_URL: process.env.WORKER_URL || "https://ramp.beenex.org",
    WEB_APP_URL: process.env.WEB_APP_URL || "https://ramp.beenex.org",

    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    BROWSER_AUTH_SECRET:
      process.env.BROWSER_AUTH_SECRET || "default-browser-auth-secret-min-32-chars-long",

    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,

    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER || "modal",
    MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID,
    MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET,
    MODAL_API_SECRET: process.env.MODAL_API_SECRET,
    MODAL_WORKSPACE: process.env.MODAL_WORKSPACE,
    MODAL_ENVIRONMENT: process.env.MODAL_ENVIRONMENT,
    MODAL_ENVIRONMENT_WEB_SUFFIX: process.env.MODAL_ENVIRONMENT_WEB_SUFFIX,

    DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
    DAYTONA_API_URL: process.env.DAYTONA_API_URL,
    E2B_API_KEY: process.env.E2B_API_KEY,
    E2B_API_URL: process.env.E2B_API_URL,
    OPENCOMPUTER_API_KEY: process.env.OPENCOMPUTER_API_KEY,
    OPENCOMPUTER_API_URL: process.env.OPENCOMPUTER_API_URL,

    SERVICE_AUTH_SECRET_WEB: process.env.SERVICE_AUTH_SECRET_WEB,
    SERVICE_AUTH_SECRET_SLACK_BOT: process.env.SERVICE_AUTH_SECRET_SLACK_BOT,
    SERVICE_AUTH_SECRET_GITHUB_BOT: process.env.SERVICE_AUTH_SECRET_GITHUB_BOT,
    SERVICE_AUTH_SECRET_LINEAR_BOT: process.env.SERVICE_AUTH_SECRET_LINEAR_BOT,

    ALLOWED_USERS: process.env.ALLOWED_USERS,
    ALLOWED_EMAIL_DOMAINS: process.env.ALLOWED_EMAIL_DOMAINS,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    ALLOWED_GITHUB_ORGS: process.env.ALLOWED_GITHUB_ORGS,
    UNSAFE_ALLOW_ALL_USERS: process.env.UNSAFE_ALLOW_ALL_USERS || "true",
  };

  envRef = env;
  return env;
}
