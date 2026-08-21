const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const CONTROL_PLANE_PORT = 8787;
const WEB_PORT = 3001;

console.log(`[Open-Inspect] Starting background services...`);

// 1. Start Control Plane on 8787
const cp = spawn('node', ['dist/server.cjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(CONTROL_PLANE_PORT),
    DATA_DIR: process.env.DATA_DIR || '/data',
    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || 'coolify-lenovo',
    APP_NAME: process.env.APP_NAME || 'Open-Inspect',
    UNSAFE_ALLOW_ALL_USERS: 'true',
  },
});

// 2. Start Next.js Web on 3001
const web = spawn('node', ['packages/web/server.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(WEB_PORT),
    CONTROL_PLANE_URL: `http://127.0.0.1:${CONTROL_PLANE_PORT}`,
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

// 3. Reverse Proxy Gateway on PORT (3000)
const server = http.createServer((req, res) => {
  const isControlPlane =
    req.url.startsWith('/sessions') ||
    req.url.startsWith('/internal') ||
    req.url.startsWith('/health');

  const targetPort = isControlPlane ? CONTROL_PLANE_PORT : WEB_PORT;

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
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

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
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
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Open-Inspect] Gateway running on http://0.0.0.0:${PORT}`);
});
