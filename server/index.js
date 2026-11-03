// HTTP + WebSocket entry point.
//   /ws                  humans (browser): space feed, Yjs doc rooms, presence, RPC
//   /api/agent/*         agents: REST outcomes (Bearer sk_agent_…)
//   /api/agent/stream    agents: wake-hint stream
//   /api/computer/stream local computers: receive agents to host
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { agentApi, agentStreamSession, MANUAL } from './agentApi.js';
import { humanSession, computerSession } from './transport.js';
import { seed } from './seed.js';

const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export async function startServer({ port = 4321, host, dataDir = path.join(root, 'data'), dev = false, quiet = false, withSeed = true, accessKey = process.env.MARGIN_ACCESS_KEY || '' } = {}) {
  const log = quiet ? () => {} : (...a) => console.log('[hub]', ...a);
  const store = new Store(dataDir);
  const hub = new Hub(store, { log });
  if (withSeed && hub.spaces.size === 0) seed(hub);

  const computerFile = path.join(dataDir, 'computer.json');
  if (!fs.existsSync(computerFile)) fs.writeFileSync(computerFile, JSON.stringify({ secret: crypto.randomBytes(24).toString('hex') }, null, 2));
  const computerSecret = JSON.parse(fs.readFileSync(computerFile, 'utf8')).secret;

  const app = express();
  const server = http.createServer(app);

  // A hub on the open internet needs a key for humans (agents and computers have their own secrets).
  const keyOk = (k) => !accessKey || safeEqual(k, accessKey);
  app.get('/api/health', (req, res) => res.json({ ok: true, needsKey: !!accessKey }));
  app.use('/api/spaces', (req, res, next) => (keyOk(req.headers['x-margin-key']) ? next() : res.status(403).json({ error: 'access key required' })));
  app.get('/api/spaces', (req, res) => res.json([...hub.spaces.values()].map((s) => ({ id: s.id, name: s.name, docs: s.docs.length, agents: s.agents.length }))));
  app.post('/api/spaces', express.json(), (req, res) => {
    const s = hub.createSpace({ name: String(req.body?.name || 'Untitled space').slice(0, 80) });
    hub.createDoc(s.id, { title: 'Untitled doc' });
    res.json({ id: s.id });
  });
  app.get('/api/manual', (req, res) => res.type('text/markdown').send(MANUAL));
  const agentHandle = agentApi(hub);
  app.use('/api/agent', express.json({ limit: '1mb' }), (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const r = agentHandle({ method: req.method, path: req.path, query: req.query, body: req.body || {}, token });
    res.status(r.status).json(r.body);
  });

  let vite;
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa', logLevel: quiet ? 'silent' : 'info' });
    app.use(vite.middlewares);
  } else if (fs.existsSync(path.join(root, 'dist'))) {
    app.use(express.static(path.join(root, 'dist')));
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (!['/ws', '/api/agent/stream', '/api/computer/stream'].includes(url.pathname)) return; // e.g. vite HMR
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sock = { send: (m) => ws.readyState === 1 && ws.send(m), close: (c, r) => ws.close(c, r) };
      let session;
      if (url.pathname === '/ws') {
        if (!keyOk(url.searchParams.get('key'))) return ws.close(4003, 'access key required');
        session = humanSession(hub, sock);
      } else if (url.pathname === '/api/agent/stream') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
        session = agentStreamSession(hub, sock, token);
      } else {
        if (!safeEqual(url.searchParams.get('secret'), computerSecret)) return ws.close(4001, 'unauthorized');
        session = computerSession(hub, sock, log);
      }
      ws.on('message', (m) => session.onMessage(m.toString()));
      ws.on('close', () => session.onClose());
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  log(`listening on http://localhost:${actualPort}`);

  return {
    hub,
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    computerSecret,
    async close() {
      for (const c of wss.clients) c.terminate();
      await vite?.close();
      hub.close();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const port = Number(process.env.PORT) || 4321;
  const srv = await startServer({ port, dev });
  let computer = null;
  if (!process.argv.includes('--no-computer')) {
    // Like Raft Computer: a separate process on this machine that hosts the local agents.
    computer = spawn(process.execPath, [path.join(root, 'bin', 'margin.js'), 'computer', '--server', srv.url, '--secret', srv.computerSecret], {
      stdio: 'inherit',
      env: process.env,
    });
  }
  console.log(`\n  Margin is running → ${srv.url}\n`);
  const stop = async () => {
    computer?.kill();
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
