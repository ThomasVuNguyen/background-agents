const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const CONTROL_PLANE_PORT = 8787;
const WEB_PORT = 3001;

console.log(`[Open-Inspect] Starting background services...`);

// Ensure matching fallback secrets for zero-config startup
const SERVICE_SECRET =
  process.env.SERVICE_AUTH_SECRET ||
  process.env.SERVICE_AUTH_SECRET_WEB ||
  'default-open-inspect-service-auth-secret-32-chars-long';

const BROWSER_SECRET =
  process.env.BROWSER_AUTH_SECRET ||
  'default-open-inspect-browser-auth-secret-32-chars-long';

const DEFAULT_ENC_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'placeholder-github-client-id';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'placeholder-github-client-secret';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://ramp.beenex.org';

// 1. Start Control Plane on 127.0.0.1:8787
const cp = spawn('node', ['dist/server.cjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(CONTROL_PLANE_PORT),
    DATA_DIR: process.env.DATA_DIR || '/data',
    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || 'coolify-lenovo',
    APP_NAME: process.env.APP_NAME || 'Open-Inspect',
    SERVICE_AUTH_SECRET_WEB: SERVICE_SECRET,
    BROWSER_AUTH_SECRET: BROWSER_SECRET,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || DEFAULT_ENC_KEY,
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY:
      process.env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY || DEFAULT_ENC_KEY,
    REPO_SECRETS_ENCRYPTION_KEY:
      process.env.REPO_SECRETS_ENCRYPTION_KEY || DEFAULT_ENC_KEY,
    GITHUB_CLIENT_ID: GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: GITHUB_CLIENT_SECRET,
    WEB_APP_URL: WEB_APP_URL,
    UNSAFE_ALLOW_ALL_USERS: 'true',
  },
});

// 2. Start Next.js Web on 127.0.0.1:3001
const web = spawn('node', ['packages/web/server.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOSTNAME: '127.0.0.1',
    PORT: String(WEB_PORT),
    CONTROL_PLANE_URL: `http://127.0.0.1:${CONTROL_PLANE_PORT}`,
    SERVICE_AUTH_SECRET: SERVICE_SECRET,
    BROWSER_AUTH_SECRET: BROWSER_SECRET,
    GITHUB_CLIENT_ID: GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: GITHUB_CLIENT_SECRET,
    WEB_APP_URL: WEB_APP_URL,
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'wss://ramp.beenex.org',
  },
});

cp.on('error', (err) => console.error('[Control-Plane Process Error]', err));
web.on('error', (err) => console.error('[Web Process Error]', err));

process.on('SIGTERM', () => {
  cp.kill('SIGTERM');
  web.kill('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  cp.kill('SIGINT');
  web.kill('SIGINT');
  process.exit(0);
});

// 3. Reverse Proxy Gateway on 0.0.0.0:PORT (3000)
const server = http.createServer((req, res) => {
  // Liveness check for Coolify / Traefik
  if (req.url === '/healthz' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  const isControlPlane =
    req.url.startsWith('/sessions') ||
    req.url.startsWith('/internal') ||
    req.url.startsWith('/health');

  const targetPort = isControlPlane ? CONTROL_PLANE_PORT : WEB_PORT;

  const headers = { ...req.headers };
  const host = headers['x-forwarded-host'] || headers['host'] || 'ramp.beenex.org';
  headers['host'] = host;
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'https';

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error(`[Gateway Proxy Error] ${req.method} ${req.url} -> port ${targetPort}: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: ' + err.message);
  });

  req.pipe(proxyReq);
});

// WebSocket Upgrade Proxy
server.on('upgrade', (req, socket, head) => {
  const isControlPlane =
    req.url.startsWith('/sessions') ||
    req.url.startsWith('/internal') ||
    req.url.startsWith('/ws');

  const targetPort = isControlPlane ? CONTROL_PLANE_PORT : WEB_PORT;

  const headers = { ...req.headers };
  const host = headers['x-forwarded-host'] || headers['host'] || 'ramp.beenex.org';
  headers['host'] = host;
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'https';

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
    );
    for (const [key, val] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(val)) {
        for (const v of val) socket.write(`${key}: ${v}\r\n`);
      } else {
        socket.write(`${key}: ${val}\r\n`);
      }
    }
    socket.write('\r\n');
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Gateway WS Proxy Error] ${req.url} -> port ${targetPort}: ${err.message}`);
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Open-Inspect] Gateway running on http://0.0.0.0:${PORT}`);
});
