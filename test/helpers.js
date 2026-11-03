import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { HubClient } from '../src/shared/sync.js';
import { AgentClient } from '../src/agent/client.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot({ seed = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-test-'));
  const srv = await startServer({ port: 0, dataDir, quiet: true, withSeed: seed });
  const space = [...srv.hub.spaces.values()][0];
  return { srv, hub: srv.hub, space, docId: space?.docs[0]?.id, dataDir, wsUrl: srv.url.replace('http', 'ws') + '/ws' };
}

export async function human(ctx, name, i = 0) {
  const c = new HubClient({ url: ctx.wsUrl, WebSocketImpl: WebSocket, user: { id: 'u-' + name, name, color: '#123456' }, spaceId: ctx.space.id });
  const d = c.openDoc(ctx.docId);
  await new Promise((r) => (d.synced ? r() : d.on('synced', r)));
  return { c, d, name };
}

// Test agents act without being woken, so they get the trusted 'space' scope unless a test asks otherwise.
export function agent(ctx, name, description = 'test agent', runtime = 'external', scope = 'space') {
  const a = ctx.hub.createAgent(ctx.space.id, { name, description, runtime, scope });
  const token = ctx.hub.mintToken(ctx.space.id, a.id, 'test');
  return { a, token, api: new AgentClient({ server: ctx.srv.url, token }) };
}

export function stream(ctx, token) {
  const ws = new WebSocket(ctx.srv.url.replace('http', 'ws') + '/api/agent/stream', { headers: { authorization: 'Bearer ' + token } });
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
  return { ws, msgs, open: new Promise((r) => ws.on('open', r)), closed: new Promise((r) => ws.on('close', (code) => r(code))) };
}

export async function until(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('timed out waiting for condition');
}
