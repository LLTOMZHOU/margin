// Cloudflare deployment: the whole hub lives in one SQLite-backed Durable Object.
// Static UI is served by Workers assets; /api/* and /ws go to the Durable Object.
//
// Secrets (set with `wrangler secret put`):
//   MARGIN_ACCESS_KEY      humans need it to open the app (invite links carry ?key=)
//   MARGIN_COMPUTER_SECRET lets `margin computer` on your machines host this hub's agents
import { DurableObject } from 'cloudflare:workers';
import { Hub } from '../server/hub.js';
import { agentApi, agentStreamSession, MANUAL } from '../server/agentApi.js';
import { humanSession, computerSession } from '../server/transport.js';
import { seed } from '../server/seed.js';
import { DOStore } from './do-store.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export class MarginHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new DOStore(ctx.storage);
    this.hub = new Hub(this.store);
    if (this.hub.spaces.size === 0) seed(this.hub, { mode: env.MARGIN_SEED || 'welcome', spaceName: env.MARGIN_SPACE_NAME });
    this.agentHandle = agentApi(this.hub);
  }

  keyOk(k) {
    return !this.env.MARGIN_ACCESS_KEY || safeEqual(k || '', this.env.MARGIN_ACCESS_KEY);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') return this.upgrade(request, url);
    const hub = this.hub;
    if (url.pathname === '/api/health') return json({ ok: true, needsKey: !!this.env.MARGIN_ACCESS_KEY, host: 'cloudflare' });
    if (url.pathname === '/api/manual') return new Response(MANUAL, { headers: { 'content-type': 'text/markdown' } });
    if (url.pathname === '/api/spaces') {
      if (!this.keyOk(request.headers.get('x-margin-key'))) return json({ error: 'access key required' }, 403);
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const s = hub.createSpace({ name: String(body.name || 'Untitled space').slice(0, 80) });
        hub.createDoc(s.id, { title: 'Untitled doc' });
        return json({ id: s.id });
      }
      return json([...hub.spaces.values()].map((s) => ({ id: s.id, name: s.name, docs: s.docs.length, agents: s.agents.length })));
    }
    if (url.pathname.startsWith('/api/agent/')) {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.json().catch(() => ({})) : {};
      const r = this.agentHandle({
        method: request.method,
        path: url.pathname.slice('/api/agent'.length),
        query: Object.fromEntries(url.searchParams),
        body,
        token,
      });
      return json(r.body, r.status);
    }
    return json({ error: 'not found' }, 404);
  }

  upgrade(request, url) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const sock = {
      send: (m) => {
        try {
          server.send(m);
        } catch {}
      },
      close: (c, r) => {
        try {
          server.close(c, r);
        } catch {}
      },
    };
    let session;
    if (url.pathname === '/ws') {
      if (!this.keyOk(url.searchParams.get('key'))) sock.close(4003, 'access key required');
      else session = humanSession(this.hub, sock);
    } else if (url.pathname === '/api/agent/stream') {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
      session = agentStreamSession(this.hub, sock, token);
    } else if (url.pathname === '/api/computer/stream') {
      if (!this.env.MARGIN_COMPUTER_SECRET || !safeEqual(url.searchParams.get('secret') || '', this.env.MARGIN_COMPUTER_SECRET)) sock.close(4001, 'unauthorized');
      else session = computerSession(this.hub, sock);
    } else sock.close(4004, 'unknown endpoint');
    if (session) {
      server.addEventListener('message', (e) => session.onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)));
      server.addEventListener('close', () => session.onClose());
      server.addEventListener('error', () => session.onClose());
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
