import http from "node:http";
import { WebSocketServer, WebSocket as NodeWs } from "ws";
import { handleRequest } from "./router";
import { loadStandaloneEnv } from "./config/env";
import { createLogger } from "./logger";
import { Scheduler } from "./scheduler/scheduler";
import {
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import { runImageBuildScheduler } from "./image-builds/scheduler";
import { SessionIndexStore } from "./db/session-index";
import { StandaloneSessionNamespace } from "./session/standalone-session-namespace";
import type { BackgroundTasks } from "./platform-ports";
import type { SqlDatabase } from "./db/sql-database";

const log = createLogger("server");

const env = loadStandaloneEnv();

const backgroundTasks: BackgroundTasks = {
  submit(task, metadata): void {
    task.catch((error) => {
      log.error("background_task.failed", {
        task_name: metadata.name,
        ...metadata.context,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },
};

/** Convert Node IncomingMessage to Web Standard Request */
async function nodeRequestToWebRequest(req: http.IncomingMessage): Promise<Request> {
  const host = req.headers.host || "localhost:8787";
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const url = `${protocol}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  let body: Buffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    body = chunks.length > 0 ? Buffer.concat(chunks) : null;
  }

  return new Request(url, {
    method: req.method,
    headers,
    body: body ? body : undefined,
    // @ts-expect-error Node duplex option
    duplex: "half",
  });
}

/** Write Web Standard Response to Node ServerResponse */
async function writeWebResponseToNode(
  webRes: Response,
  nodeRes: http.ServerResponse
): Promise<void> {
  nodeRes.statusCode = webRes.status;
  nodeRes.statusMessage = webRes.statusText;

  webRes.headers.forEach((value, key) => {
    nodeRes.setHeader(key, value);
  });

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  } finally {
    nodeRes.end();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  try {
    const webRequest = await nodeRequestToWebRequest(req);
    const webResponse = await handleRequest(webRequest, env, backgroundTasks);
    await writeWebResponseToNode(webResponse, res);
  } catch (error) {
    log.error("Unhandled HTTP error", {
      url: req.url,
      method: req.method,
      error: error instanceof Error ? error.stack : String(error),
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on("connection", async (ws: NodeWs, req: http.IncomingMessage) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    log.warn("Invalid WebSocket path", { path: url.pathname });
    ws.close(1002, "Invalid WebSocket path");
    return;
  }

  const sessionId = match[1];
  const db = env.DB as unknown as SqlDatabase;

  const sessionExists = await new SessionIndexStore(db).exists(sessionId);
  if (!sessionExists) {
    log.warn("Session not found for WS connection", { sessionId });
    ws.close(1008, "Session not found");
    return;
  }

  const sessionNamespace = env.SESSION as unknown as StandaloneSessionNamespace;
  const activeSession = sessionNamespace.getOrCreateSession(sessionId);

  log.info("WebSocket connected to session", { sessionId, url: req.url });

  // Handle message forwarding between external ws and SessionDO
  ws.on("message", async (data: Buffer | string) => {
    try {
      const msgStr = typeof data === "string" ? data : data.toString("utf-8");
      // Forward to SessionDO
      await activeSession.instance.fetch(
        new Request(`http://localhost/internal/message`, {
          method: "POST",
          body: msgStr,
        })
      );
    } catch (err) {
      log.error("Failed to forward WS message to session", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("close", async (code, reason) => {
    log.info("WebSocket closed", { sessionId, code, reason: reason.toString() });
  });

  ws.on("error", (err) => {
    log.error("WebSocket error", { sessionId, error: err.message });
  });
});

// Schedulers (Background Timers)
// 1. Scheduler tick every 60s
setInterval(async () => {
  try {
    await new Scheduler(env.DB as unknown as SqlDatabase, env, backgroundTasks).tick();
  } catch (err) {
    log.error("Scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 60 * 1000);

// 2. Abandoned draft sweep every 10 min
setInterval(async () => {
  try {
    await new AbandonedDraftSweep(
      new SessionIndexStore(env.DB as unknown as SqlDatabase),
      new SessionDraftExpiryClient(env.SESSION),
      log
    ).run(Date.now());
  } catch (err) {
    log.error("Abandoned draft sweep failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 10 * 60 * 1000);

// 3. Image build scheduler every 30 min
setInterval(async () => {
  try {
    const requestId = crypto.randomUUID();
    await runImageBuildScheduler(env, env.DB as unknown as SqlDatabase, {
      request_id: requestId,
      trace_id: requestId,
    });
  } catch (err) {
    log.error("Image build scheduler failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 30 * 60 * 1000);

const PORT = parseInt(process.env.PORT || "8787", 10);
server.listen(PORT, "0.0.0.0", () => {
  log.info(`Open-Inspect Control Plane listening on http://0.0.0.0:${PORT}`);
});
