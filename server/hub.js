// The hub: the one place that knows the truth about spaces, docs, threads, proposals and agents.
//
// Humans edit text directly through Yjs. Everything with consequences for other people
// (threads, proposals, votes, agent membership) goes through hub methods, so the hub can
// stamp authorship, enforce policy, and drop events into agents' durable inboxes.
//
// The hub never runs an agent. Agents live on someone's computer and reach the hub over
// the agent API (see agentApi.js); the hub only sends them content-free wake hints.
import crypto from 'node:crypto';
import * as Y from 'yjs';
import {
  uid,
  blocksOf,
  threadsOf,
  proposalsOf,
  logOf,
  metaOf,
  makeBlock,
  findBlock,
  blockText,
  encodeRel,
  resolveRel,
  merge3,
  applyTextMinimal,
  toB64,
  fromB64,
  POLICIES,
  BLOCK_TYPES,
} from '../src/shared/schema.js';

export const AGENT_COLORS = ['#7c5cff', '#0f9d8a', '#e0642b', '#d6336c', '#2b7de0', '#a07400', '#5f7f1a', '#8a3ffc'];
export const HUMAN_COLORS = ['#c2410c', '#0369a1', '#15803d', '#7e22ce', '#be123c', '#4d7c0f', '#b45309', '#0e7490'];
export const RUNTIMES = {
  sim: 'Built-in sim (offline, rule-based)',
  'claude-api': 'Claude API (Claude Opus 5.5, needs ANTHROPIC_API_KEY on the computer)',
  'claude-code': 'Claude Code (headless `claude -p` on the computer)',
  codex: 'Codex (headless `codex exec` on the computer)',
  external: 'External — you run it (CLI, SDK or MCP)',
};
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const LEASE_TTL_MS = 45_000;
const MAX_AGENT_HOPS = 3;
const GRANT_TTL_MS = 30 * 60 * 1000;
export const SCOPES = {
  wake: 'Only what it was asked: reply in that thread, edit the passage it was asked about',
  space: 'Anything in the space (trusted agents only)',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const outcome = (ok, state, text, data = undefined, next = undefined) => ({ ok, state, text, data, next });

export class Hub {
  constructor(store, { log = () => {} } = {}) {
    this.store = store;
    this.log = log;
    this.spaces = new Map(); // id -> space (persisted)
    this.docs = new Map(); // `${spaceId}/${docId}` -> live doc state
    this.humanConns = new Set();
    this.agentRuntime = new Map(); // agentId -> { status, detail, occurredAt, seenAt, streams:Set, readDocs:Map }
    this.inboxes = new Map(); // agentId -> inbox
    this.heldSends = new Map(); // idempotencyKey -> { agentId, threadId, docId, text }
    this.sentKeys = new Map(); // idempotencyKey -> result (dedupe retries)
    this.computers = new Set(); // connected local computers
    for (const id of store.listSpaces()) this.spaces.set(id, store.loadSpace(id));
    this.sweeper = setInterval(() => this.sweepLeases(), 2000);
    this.sweeper.unref?.();
  }

  // ---------------------------------------------------------------- spaces

  createSpace({ name, instructions = '' }) {
    const space = { id: uid('s'), name, instructions, createdAt: Date.now(), docs: [], agents: [], humans: {} };
    this.spaces.set(space.id, space);
    this.store.saveSpace(space);
    return space;
  }

  space(spaceId) {
    const s = this.spaces.get(spaceId);
    if (!s) throw new Error('no such space');
    return s;
  }

  saveSpace(space) {
    this.store.saveSpace(space);
    this.broadcastSpace(space.id);
  }

  onlineHumans(spaceId) {
    const seen = new Map();
    for (const c of this.humanConns) if (c.spaceId === spaceId && c.user) seen.set(c.user.id, c.user);
    return [...seen.values()];
  }

  agentState(agentId) {
    let st = this.agentRuntime.get(agentId);
    if (!st) {
      st = { status: 'offline', detail: '', occurredAt: 0, seenAt: 0, streams: new Set(), readDocs: new Map() };
      this.agentRuntime.set(agentId, st);
    }
    return st;
  }

  // Online = an open wake stream, or an API call in the last 2 minutes. A stream that closes ends
  // the session at once (offline right away) unless the agent calls in again afterwards.
  agentOnline(agentId) {
    const st = this.agentState(agentId);
    if (st.streams.size > 0) return true;
    return Date.now() - st.seenAt < ONLINE_WINDOW_MS && st.seenAt > (st.sessionEndedAt || 0);
  }

  publicSpace(spaceId) {
    const s = this.space(spaceId);
    const online = this.onlineHumans(spaceId);
    return {
      id: s.id,
      name: s.name,
      instructions: s.instructions,
      docs: s.docs,
      policies: POLICIES,
      runtimes: RUNTIMES,
      humans: Object.values(s.humans).map((h) => ({ ...h, online: online.some((o) => o.id === h.id) })),
      agents: s.agents.map((a) => {
        const st = this.agentState(a.id);
        const isOnline = this.agentOnline(a.id) && st.status !== 'offline';
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          color: a.color,
          runtime: a.runtime,
          host: a.host,
          scope: a.scope || 'wake',
          quarantine: !!a.quarantine,
          createdAt: a.createdAt,
          tokens: a.tokens.map((t) => ({ prefix: t.prefix, label: t.label, createdAt: t.createdAt })),
          online: isOnline,
          status: isOnline ? st.status : 'offline',
          detail: st.detail,
          lastSeen: st.seenAt,
          pending: this.inbox(a.id).events.filter((e) => e.seq > this.inbox(a.id).acked).length,
        };
      }),
    };
  }

  broadcastSpace(spaceId) {
    clearTimeout(this._spaceTimer?.[spaceId]);
    this._spaceTimer = this._spaceTimer || {};
    this._spaceTimer[spaceId] = setTimeout(() => {
      const msg = JSON.stringify({ t: 'space', space: this.publicSpace(spaceId) });
      for (const c of this.humanConns) if (c.spaceId === spaceId) c.sendRaw(msg);
    }, 30);
  }

  setInstructions(spaceId, text) {
    const s = this.space(spaceId);
    s.instructions = String(text).slice(0, 20000);
    this.saveSpace(s);
  }

  touchHuman(spaceId, user) {
    const s = this.space(spaceId);
    s.humans[user.id] = { id: user.id, name: user.name, color: user.color, lastSeen: Date.now() };
    this.store.saveSpace(s);
  }

  // ---------------------------------------------------------------- docs

  createDoc(spaceId, { title, blocks, policy = 'one' }) {
    const s = this.space(spaceId);
    const docId = uid('d');
    s.docs.push({ id: docId, title, createdAt: Date.now() });
    const d = this.doc(spaceId, docId);
    d.ydoc.transact(() => {
      metaOf(d.ydoc).set('title', title);
      metaOf(d.ydoc).set('policy', policy);
      const bs = blocks?.length ? blocks : [['p', '']];
      blocksOf(d.ydoc).push(bs.map(([type, text]) => makeBlock(type, text)));
    }, 'hub');
    this.saveSpace(s);
    return docId;
  }

  removeDoc(spaceId, docId, actor) {
    const s = this.space(spaceId);
    if (s.docs.length <= 1) throw new Error('A space keeps at least one doc.');
    if (!s.docs.some((x) => x.id === docId)) throw new Error('no such doc');
    const d = this.docs.get(spaceId + '/' + docId);
    if (d) {
      for (const c of d.conns) c.sendRaw(JSON.stringify({ t: 'event', kind: 'doc-removed', docId, text: `${actor.name} deleted this doc` }));
      d.ydoc.destroy();
      this.docs.delete(spaceId + '/' + docId);
    }
    s.docs = s.docs.filter((x) => x.id !== docId);
    this.store.deleteDoc(spaceId, docId);
    this.saveSpace(s);
  }

  doc(spaceId, docId) {
    const key = spaceId + '/' + docId;
    let d = this.docs.get(key);
    if (d) return d;
    const s = this.space(spaceId);
    if (!s.docs.some((x) => x.id === docId)) throw new Error('no such doc');
    const ydoc = new Y.Doc();
    const bytes = this.store.loadDoc(spaceId, docId);
    if (bytes) Y.applyUpdate(ydoc, bytes, 'disk');
    d = { spaceId, docId, ydoc, conns: new Set(), presence: new Map(), leases: new Map(), version: 0, cache: null };
    ydoc.on('update', (u, origin) => {
      d.version++;
      const msg = JSON.stringify({ t: 'up', docId, u: toB64(u) });
      for (const c of d.conns) if (c !== origin) c.sendRaw(msg);
      this.store.saveDoc(spaceId, docId, () => Y.encodeStateAsUpdate(ydoc));
    });
    metaOf(ydoc).observe(() => {
      const entry = s.docs.find((x) => x.id === docId);
      const title = metaOf(ydoc).get('title');
      if (entry && title && entry.title !== title) {
        entry.title = title;
        this.saveSpace(s);
      }
    });
    this.docs.set(key, d);
    return d;
  }

  appendLog(d, actor, kind, summary, ref = {}) {
    const log = logOf(d.ydoc);
    const entry = {
      seq: log.length + 1,
      ts: Date.now(),
      actor: { id: actor.id, name: actor.name, kind: actor.kind, color: actor.color },
      kind,
      summary,
      ...ref,
    };
    d.ydoc.transact(() => log.push([entry]), 'hub');
    return entry;
  }

  setPolicy(spaceId, docId, policy, actor) {
    if (!POLICIES[policy]) throw new Error('bad policy');
    const d = this.doc(spaceId, docId);
    d.ydoc.transact(() => metaOf(d.ydoc).set('policy', policy), 'hub');
    this.appendLog(d, actor, 'policy', `set agent edit policy to “${POLICIES[policy]}”`);
    this.reconsiderPending(d);
  }

  // ---------------------------------------------------------------- presence + leases

  presenceList(d) {
    const peers = [...d.presence.values()];
    const now = Date.now();
    const s = this.space(d.spaceId);
    for (const a of s.agents) {
      const st = this.agentState(a.id);
      const lease = [...d.leases.entries()].find(([, l]) => l.agentId === a.id);
      const readAt = st.readDocs.get(d.docId) || 0;
      if (lease || now - readAt < 60_000) {
        peers.push({
          id: a.id,
          name: a.name,
          color: a.color,
          kind: 'agent',
          blockId: lease ? lease[0] : null,
          status: this.agentOnline(a.id) ? st.status : 'offline',
          detail: st.detail,
        });
      }
    }
    return peers;
  }

  broadcastPresence(d) {
    clearTimeout(d.presenceTimer);
    d.presenceTimer = setTimeout(() => {
      const msg = JSON.stringify({ t: 'presence', docId: d.docId, peers: this.presenceList(d) });
      const leases = JSON.stringify({ t: 'leases', docId: d.docId, leases: this.leaseList(d) });
      for (const c of d.conns) {
        c.sendRaw(msg);
        c.sendRaw(leases);
      }
    }, 25);
  }

  leaseList(d) {
    return [...d.leases.entries()].map(([blockId, l]) => ({ blockId, ...l }));
  }

  claimLease(spaceId, docId, agent, blockIds, ttlMs = LEASE_TTL_MS) {
    const denied = this.checkScope(agent, 'lease', { docId, blockIds });
    if (denied) return denied;
    const d = this.doc(spaceId, docId);
    const now = Date.now();
    const taken = [];
    for (const b of blockIds) {
      if (!findBlock(d.ydoc, b)) return outcome(false, 'not_found', `Block ${b} does not exist in this doc.`);
      const l = d.leases.get(b);
      if (l && l.agentId !== agent.id && l.expires > now) taken.push({ blockId: b, heldBy: l.name, expiresInMs: l.expires - now });
    }
    if (taken.length)
      return outcome(
        false,
        'leased',
        `Not claimed. ${taken.map((t) => `${t.blockId} is leased by ${t.heldBy} for ${Math.ceil(t.expiresInMs / 1000)}s more`).join('; ')}. Work on a different block, or wait.`,
        { taken },
      );
    for (const b of blockIds) d.leases.set(b, { agentId: agent.id, name: agent.name, color: agent.color, expires: now + Math.min(ttlMs, 5 * 60_000) });
    this.broadcastPresence(d);
    return outcome(true, 'claimed', `Claimed ${blockIds.join(', ')} for ${Math.round(Math.min(ttlMs, 300000) / 1000)}s. Other agents cannot propose changes to these blocks until you release them or the lease expires.`);
  }

  releaseLeases(agentId, spaceId = null, docId = null) {
    for (const d of this.docs.values()) {
      if (spaceId && d.spaceId !== spaceId) continue;
      if (docId && d.docId !== docId) continue;
      let changed = false;
      for (const [b, l] of d.leases) if (l.agentId === agentId) d.leases.delete(b), (changed = true);
      if (changed) this.broadcastPresence(d);
    }
  }

  sweepLeases() {
    const now = Date.now();
    for (const d of this.docs.values()) {
      let changed = false;
      for (const [b, l] of d.leases) if (l.expires <= now) d.leases.delete(b), (changed = true);
      if (changed) this.broadcastPresence(d);
    }
  }

  // ---------------------------------------------------------------- agents

  createAgent(spaceId, { name, description = '', runtime = 'sim', scope = 'wake', quarantine = false }) {
    const s = this.space(spaceId);
    name = String(name || '').trim().replace(/\s+/g, '-');
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) throw new Error('Agent names are 2–24 letters, digits, - or _ (they are @mentioned).');
    if (s.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error('An agent with that name already exists.');
    if (!RUNTIMES[runtime]) throw new Error('unknown runtime');
    const agent = {
      id: uid('a'),
      name,
      description,
      color: AGENT_COLORS[s.agents.length % AGENT_COLORS.length],
      runtime,
      host: runtime === 'external' ? 'external' : 'local-computer',
      scope: SCOPES[scope] ? scope : 'wake',
      quarantine: !!quarantine,
      tokens: [],
      createdAt: Date.now(),
    };
    s.agents.push(agent);
    this.saveSpace(s);
    this.offerToComputers(s, agent);
    return agent;
  }

  updateAgent(spaceId, agentId, patch) {
    const s = this.space(spaceId);
    const a = s.agents.find((x) => x.id === agentId);
    if (!a) throw new Error('no such agent');
    if (patch.description !== undefined) a.description = String(patch.description).slice(0, 4000);
    if (patch.runtime !== undefined) {
      if (!RUNTIMES[patch.runtime]) throw new Error('unknown runtime');
      a.runtime = patch.runtime;
      a.host = a.runtime === 'external' ? 'external' : 'local-computer';
    }
    if (patch.scope !== undefined) {
      if (!SCOPES[patch.scope]) throw new Error('unknown scope');
      a.scope = patch.scope;
    }
    if (patch.quarantine !== undefined) a.quarantine = !!patch.quarantine;
    this.saveSpace(s);
    for (const c of this.computers) c.send({ type: 'unhost', agentId: a.id });
    if (a.host === 'local-computer') this.offerToComputers(s, a);
    return a;
  }

  removeAgent(spaceId, agentId) {
    const s = this.space(spaceId);
    s.agents = s.agents.filter((a) => a.id !== agentId);
    const st = this.agentState(agentId);
    for (const ws of st.streams) ws.close(4001, 'agent removed');
    for (const c of this.computers) c.send({ type: 'unhost', agentId });
    this.releaseLeases(agentId);
    this.saveSpace(s);
  }

  mintToken(spaceId, agentId, label = 'manual') {
    const s = this.space(spaceId);
    const a = s.agents.find((x) => x.id === agentId);
    if (!a) throw new Error('no such agent');
    const token = 'sk_agent_' + crypto.randomBytes(24).toString('hex');
    if (label === 'local-computer') a.tokens = a.tokens.filter((t) => t.label !== 'local-computer');
    a.tokens.push({ prefix: token.slice(0, 16), hash: sha256(token), label, createdAt: Date.now() });
    this.saveSpace(s);
    return token;
  }

  revokeToken(spaceId, agentId, prefix) {
    const s = this.space(spaceId);
    const a = s.agents.find((x) => x.id === agentId);
    if (!a) throw new Error('no such agent');
    a.tokens = a.tokens.filter((t) => t.prefix !== prefix);
    for (const ws of this.agentState(agentId).streams) if (ws.tokenPrefix === prefix) ws.close(4001, 'credential revoked');
    this.saveSpace(s);
  }

  authenticate(token) {
    if (!token || !token.startsWith('sk_agent_')) return null;
    const h = sha256(token);
    for (const s of this.spaces.values())
      for (const a of s.agents)
        if (a.tokens.some((t) => t.hash === h)) {
          const st = this.agentState(a.id);
          st.seenAt = Date.now();
          return { space: s, agent: { ...a, scope: a.scope || 'wake', kind: 'agent' }, tokenPrefix: token.slice(0, 16) };
        }
    return null;
  }

  reportStatus(agentId, spaceId, { eventId, occurredAt, status, detail = '' }) {
    if (!['online', 'thinking', 'working', 'error', 'offline'].includes(status)) return outcome(false, 'status_invalid', 'Unknown status.');
    if (typeof detail !== 'string') return outcome(false, 'detail_invalid', 'detail must be a string.');
    if (detail.length > 200) return outcome(false, 'detail_too_long', 'detail must be at most 200 characters.');
    if (!eventId || !occurredAt) return outcome(false, 'rejected', 'A status event needs eventId and occurredAt.');
    const st = this.agentState(agentId);
    st.seenEvents = st.seenEvents || new Set();
    if (st.seenEvents.has(eventId)) return outcome(true, 'duplicate', 'Already recorded.');
    st.seenEvents.add(eventId);
    const at = Math.min(new Date(occurredAt).getTime() || Date.now(), Date.now());
    if (at < st.occurredAt) return outcome(true, 'stale', 'A newer status is already recorded.');
    Object.assign(st, { status, detail, occurredAt: at });
    if (status === 'online' || status === 'offline') this.releaseLeases(agentId, spaceId);
    this.broadcastSpace(spaceId);
    for (const d of this.docs.values()) if (d.spaceId === spaceId) this.broadcastPresence(d);
    return outcome(true, 'recorded', `Status is now ${status}${detail ? ` (${detail})` : ''}.`);
  }

  // ---------------------------------------------------------------- local computers

  computerView(a) {
    return { id: a.id, name: a.name, description: a.description, runtime: a.runtime, color: a.color, scope: a.scope || 'wake', quarantine: !!a.quarantine };
  }

  // A computer hosts every local-computer agent in every space on this hub.
  attachComputer(conn) {
    this.computers.add(conn);
    for (const s of this.spaces.values()) for (const a of s.agents) if (a.host === 'local-computer') this.offerToComputers(s, a, conn);
  }

  detachComputer(conn) {
    this.computers.delete(conn);
  }

  offerToComputers(space, agent, only = null) {
    if (agent.host !== 'local-computer') return;
    for (const c of only ? [only] : this.computers) {
      const token = this.mintToken(space.id, agent.id, 'local-computer');
      c.send({ type: 'host', agent: this.computerView(agent), token });
    }
  }

  // ---------------------------------------------------------------- inbox + wake hints

  inbox(agentId) {
    let ib = this.inboxes.get(agentId);
    if (!ib) {
      const s = [...this.spaces.values()].find((sp) => sp.agents.some((a) => a.id === agentId));
      ib = s ? this.store.loadInbox(s.id, agentId) : { nextSeq: 1, acked: 0, events: [] };
      ib.spaceId = s?.id;
      this.inboxes.set(agentId, ib);
    }
    return ib;
  }

  deliver(agentId, event) {
    const ib = this.inbox(agentId);
    const e = { seq: ib.nextSeq++, ts: Date.now(), ...event };
    const g = this.grantFor(agentId, e);
    if (g) e.grant = g;
    ib.events.push(e);
    // keep acked history short, never drop unacked events
    const firstUnacked = ib.events.findIndex((x) => x.seq > ib.acked);
    if (firstUnacked > 200) ib.events.splice(0, firstUnacked - 200);
    this.store.saveInbox(ib.spaceId, agentId, ib);
    const pending = ib.events.filter((x) => x.seq > ib.acked);
    const hint = JSON.stringify({
      type: 'wake',
      wakeId: uid('w'),
      target: e.target,
      flags: e.flags || [],
      pendingCount: pending.length,
      latestSender: e.from?.name,
    });
    for (const ws of this.agentState(agentId).streams) ws.send(hint);
    this.broadcastSpace(ib.spaceId);
    return e;
  }

  // A pull acknowledges nothing. Passing the cursor of the batch you finished as `since` does.
  inboxCheck(agentId, since, limit = 20) {
    const ib = this.inbox(agentId);
    if (since !== undefined && since !== null && since !== '') {
      const n = Number(since);
      if (Number.isFinite(n) && n > ib.acked) ib.acked = Math.min(n, ib.nextSeq - 1);
      this.store.saveInbox(ib.spaceId, agentId, ib);
    }
    const events = ib.events.filter((e) => e.seq > ib.acked).slice(0, limit);
    const cursor = events.length ? events[events.length - 1].seq : ib.acked;
    const remaining = ib.events.filter((e) => e.seq > cursor).length;
    this.broadcastSpace(ib.spaceId);
    return { events, cursor, remaining };
  }

  // ---------------------------------------------------------------- threads

  threadView(d, t) {
    const blockId = t.get('blockId');
    let range = null;
    if (blockId) {
      const start = resolveRel(d.ydoc, t.get('start'));
      const end = resolveRel(d.ydoc, t.get('end'));
      if (start !== null && end !== null) range = { start, end };
    }
    return {
      id: t.get('id'),
      blockId,
      quote: t.get('quote'),
      range,
      resolved: t.get('resolved'),
      createdBy: t.get('createdBy'),
      createdAt: t.get('createdAt'),
      messages: t.get('messages').toArray(),
    };
  }

  createThread(spaceId, docId, actor, { blockId = null, start = null, end = null, quote = '', text, hop = 0 }) {
    const d = this.doc(spaceId, docId);
    if (blockId && !findBlock(d.ydoc, blockId)) throw new Error('no such block');
    const id = uid('t');
    d.ydoc.transact(() => {
      const t = new Y.Map();
      t.set('id', id);
      t.set('blockId', blockId);
      t.set('start', start);
      t.set('end', end);
      t.set('quote', String(quote).slice(0, 500));
      t.set('resolved', false);
      t.set('createdBy', { id: actor.id, name: actor.name, kind: actor.kind, color: actor.color });
      t.set('createdAt', Date.now());
      t.set('messages', new Y.Array());
      threadsOf(d.ydoc).set(id, t);
    }, 'hub');
    this.appendLog(d, actor, 'thread', quote ? `opened a thread on “${quote.slice(0, 60)}”` : 'opened a thread', { threadId: id });
    const msg = this.postMessage(spaceId, docId, id, actor, { text, hop });
    return { threadId: id, messageId: msg.id };
  }

  // ---------------------------------------------------------------- per-wake capabilities
  //
  // Every event an agent receives grants it a narrow, time-limited scope derived from the trusted
  // trigger (who asked, in which thread, about which passage), never from the text it will read.
  // A doc or message that tries to steer the agent elsewhere hits the hub's refusal, not the model's.

  grantFor(agentId, e) {
    if (!e.docId) return null;
    let blockId = null;
    let threadId = e.threadId || null;
    const d = this.docs.get(this.inbox(agentId).spaceId + '/' + e.docId) || null;
    if (e.kind === 'message' && d && threadId) blockId = threadsOf(d.ydoc).get(threadId)?.get('blockId') || null;
    if (e.kind === 'proposal' && d) {
      const p = proposalsOf(d.ydoc).get(e.proposalId);
      blockId = p?.blockId || p?.afterBlockId || null;
      threadId = p?.threadId || null;
    }
    // Stored on the inbox event itself, so grants survive hub restarts with the inbox.
    return { docId: e.docId, threadId, blockId, expiresAt: Date.now() + GRANT_TTL_MS };
  }

  describeGrant(g) {
    if (!g) return '';
    const where = g.blockId ? `block ${g.blockId}` : `any block of doc ${g.docId}`;
    return `you may: reply in ${g.threadId || '(no thread)'}, propose edits/comments on ${where}`;
  }

  // action: 'reply' | 'comment' | 'propose' | 'lease'; t: { docId, threadId, blockIds }
  checkScope(agent, action, t) {
    if (agent.scope === 'space') return null;
    const now = Date.now();
    const grants = this.inbox(agent.id)
      .events.map((e) => e.grant)
      .filter((g) => g && g.expiresAt > now && g.docId === t.docId);
    const ok = grants.some((g) => {
      if (action === 'reply') return g.threadId && g.threadId === t.threadId;
      const ids = (t.blockIds || []).filter(Boolean);
      if (!g.blockId) return true; // doc-level ask: anywhere in this doc
      return ids.length > 0 && ids.every((b) => b === g.blockId);
    });
    if (ok) return null;
    const allowed = grants.map((g) => this.describeGrant(g)).join('; ') || 'nothing in this doc right now';
    return outcome(
      false,
      'out_of_scope',
      `Refused: this agent only acts where it was asked. For doc ${t.docId} ${allowed}. ` +
        `If the request needs more, say so in the thread and let a human ask you directly.`,
    );
  }

  // Agents anchor comments by quoting the text they mean.
  agentComment(spaceId, docId, agent, { blockId, quote, text, hop }) {
    const denied = this.checkScope(agent, 'comment', { docId, blockIds: [blockId] });
    if (denied) return denied;
    const d = this.doc(spaceId, docId);
    const found = findBlock(d.ydoc, blockId);
    if (!found) return outcome(false, 'not_found', `Block ${blockId} does not exist. Read the doc again for current block ids.`);
    const ytext = found.block.get('text');
    const full = ytext.toString();
    let at = quote ? full.indexOf(quote) : -1;
    let q = quote;
    if (at < 0) {
      at = 0;
      q = full;
    }
    const r = this.createThread(spaceId, docId, agent, {
      blockId,
      start: encodeRel(ytext, at, 0),
      end: encodeRel(ytext, at + q.length, -1),
      quote: q,
      text,
      hop,
    });
    return outcome(true, 'created', `Comment thread ${r.threadId} opened on ${blockId}${quote && at >= 0 && q === quote ? '' : ' (quote not found, anchored to the whole block)'}.`, r);
  }

  postMessage(spaceId, docId, threadId, actor, { text, hop = 0 }) {
    const d = this.doc(spaceId, docId);
    const t = threadsOf(d.ydoc).get(threadId);
    if (!t) throw new Error('no such thread');
    text = String(text || '').trim().slice(0, 8000);
    if (!text) throw new Error('empty message');
    const msg = {
      id: uid('m'),
      author: { id: actor.id, name: actor.name, kind: actor.kind, color: actor.color },
      text,
      ts: Date.now(),
      hop,
    };
    d.ydoc.transact(() => {
      t.get('messages').push([msg]);
      if (t.get('resolved') && actor.kind === 'human') t.set('resolved', false);
    }, 'hub');
    this.routeMessage(d, t, msg);
    return msg;
  }

  mentionedAgents(space, text) {
    const names = new Set([...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase()));
    if (names.has('agents') || names.has('all')) return space.agents.slice();
    return space.agents.filter((a) => names.has(a.name.toLowerCase()));
  }

  // Decide which agents get an inbox event for a new thread message.
  routeMessage(d, t, msg) {
    const space = this.space(d.spaceId);
    const target = `thread:${d.docId}/${t.get('id')}`;
    const mentioned = this.mentionedAgents(space, msg.text).filter((a) => a.id !== msg.author.id);
    const hop = msg.author.kind === 'agent' ? msg.hop : 0;
    if (hop >= MAX_AGENT_HOPS) return;
    const base = {
      kind: 'message',
      target,
      docId: d.docId,
      threadId: t.get('id'),
      messageId: msg.id,
      from: msg.author,
      quote: t.get('quote'),
      text: msg.text,
      hop: hop + (msg.author.kind === 'agent' ? 1 : 0),
    };
    const notified = new Set();
    for (const a of mentioned) {
      notified.add(a.id);
      this.deliver(a.id, { ...base, flags: ['mention', 'thread'] });
    }
    // Humans replying in a thread an agent took part in wake that agent too.
    if (msg.author.kind === 'human') {
      const participants = new Set(
        t
          .get('messages')
          .toArray()
          .filter((m) => m.author.kind === 'agent')
          .map((m) => m.author.id),
      );
      for (const id of participants) {
        if (notified.has(id) || !space.agents.some((a) => a.id === id)) continue;
        this.deliver(id, { ...base, flags: ['thread'] });
      }
    }
  }

  // Raft-style held send: if the thread moved on since the agent last read it, hold the reply
  // and show the agent what it missed. Resending with the idempotency key goes ahead.
  agentReply(spaceId, docId, threadId, agent, { text, seenThrough, idempotencyKey, hop = 1 }) {
    const denied = this.checkScope(agent, 'reply', { docId, threadId });
    if (denied) return denied;
    const d = this.doc(spaceId, docId);
    const t = threadsOf(d.ydoc).get(threadId);
    if (!t) return outcome(false, 'not_found', `Thread ${threadId} not found.`);
    if (idempotencyKey && this.sentKeys.has(idempotencyKey)) return this.sentKeys.get(idempotencyKey);
    const held = idempotencyKey && this.heldSends.get(idempotencyKey);
    if (!held && seenThrough) {
      const msgs = t.get('messages').toArray();
      const idx = msgs.findIndex((m) => m.id === seenThrough);
      const newer = idx < 0 ? [] : msgs.slice(idx + 1).filter((m) => m.author.id !== agent.id);
      if (newer.length) {
        const key = uid('k');
        this.heldSends.set(key, { agentId: agent.id, threadId, docId, text });
        return outcome(
          false,
          'interrupted',
          `Held: ${newer.length} new message(s) arrived in this thread after you read it:\n` +
            newer.map((m) => `  [${m.author.kind}] @${m.author.name}: ${m.text}`).join('\n') +
            `\nIf your reply still fits, resend it with idempotency key ${key}. Otherwise write a new reply with seen_through=${newer[newer.length - 1].id}.`,
          { interrupt: { context: newer, resume: { idempotencyKey: key } } },
        );
      }
    }
    if (held) this.heldSends.delete(idempotencyKey);
    const msg = this.postMessage(spaceId, docId, threadId, agent, { text, hop });
    const res = outcome(true, 'sent', `Replied in ${threadId}.`, { messageId: msg.id });
    if (idempotencyKey) this.sentKeys.set(idempotencyKey, res);
    return res;
  }

  resolveThread(spaceId, docId, threadId, resolved, actor) {
    const d = this.doc(spaceId, docId);
    const t = threadsOf(d.ydoc).get(threadId);
    if (!t) throw new Error('no such thread');
    d.ydoc.transact(() => t.set('resolved', !!resolved), 'hub');
    this.appendLog(d, actor, 'thread', `${resolved ? 'resolved' : 'reopened'} a thread`, { threadId });
  }

  // ---------------------------------------------------------------- proposals

  leaseConflict(d, agent, blockIds) {
    const now = Date.now();
    for (const b of blockIds) {
      const l = d.leases.get(b);
      if (l && l.agentId !== agent.id && l.expires > now) return l;
    }
    return null;
  }

  propose(spaceId, docId, agent, p) {
    const denied = this.checkScope(agent, 'propose', { docId, blockIds: [p.kind === 'insert' ? p.afterBlockId : p.blockId] });
    if (denied) return denied;
    const d = this.doc(spaceId, docId);
    const kind = p.kind;
    if (!['edit', 'insert', 'delete'].includes(kind)) return outcome(false, 'invalid', 'kind must be edit, insert or delete.');
    const target = kind === 'insert' ? p.afterBlockId : p.blockId;
    if (target && !findBlock(d.ydoc, target))
      return outcome(false, 'not_found', `Block ${target} does not exist (it may have been deleted). Read the doc again.`);
    const l = target && this.leaseConflict(d, agent, [target]);
    if (l) return outcome(false, 'leased', `${target} is leased by ${l.name}. Pick another block, or wait ${Math.ceil((l.expires - Date.now()) / 1000)}s.`);

    const proposal = {
      id: uid('p'),
      kind,
      blockId: p.blockId || null,
      afterBlockId: p.afterBlockId || null,
      author: { id: agent.id, name: agent.name, kind: 'agent', color: agent.color },
      rationale: String(p.rationale || '').slice(0, 2000),
      threadId: p.threadId || null,
      status: 'pending',
      votes: {},
      createdAt: Date.now(),
    };
    if (kind === 'edit') {
      if (typeof p.text !== 'string') return outcome(false, 'invalid', 'edit needs text (the full new text of the block).');
      if (typeof p.baseText !== 'string') return outcome(false, 'invalid', 'edit needs base_text: the block text you read, so the hub can merge concurrent edits.');
      const current = blockText(findBlock(d.ydoc, p.blockId).block);
      const m = merge3(p.baseText, p.text, current);
      if (!m.ok)
        return outcome(
          false,
          'interrupted',
          `Held: ${p.blockId} changed under you in the same words you edited.\nCurrent text: ${current}\nRe-propose against the current text (use it as base_text).`,
          { current, conflicts: m.conflicts },
        );
      proposal.baseText = p.baseText;
      proposal.newText = p.text;
      proposal.newType = BLOCK_TYPES.includes(p.type) ? p.type : null;
      proposal.preview = { before: current, after: m.text };
    } else if (kind === 'insert') {
      const blocks = (p.blocks || []).filter((b) => b && typeof b.text === 'string').slice(0, 30);
      if (!blocks.length) return outcome(false, 'invalid', 'insert needs blocks: [{ type, text }].');
      proposal.blocks = blocks.map((b) => ({ type: BLOCK_TYPES.includes(b.type) ? b.type : 'p', text: b.text.slice(0, 8000) }));
    } else if (kind === 'delete') {
      proposal.preview = { before: blockText(findBlock(d.ydoc, p.blockId).block), after: '' };
    }
    d.ydoc.transact(() => proposalsOf(d.ydoc).set(proposal.id, proposal), 'hub');
    this.appendLog(d, agent, 'proposal', `proposed ${kind === 'edit' ? 'an edit to' : kind === 'insert' ? 'new blocks after' : 'deleting'} ${target || 'the top'}`, { proposalId: proposal.id });
    const policy = metaOf(d.ydoc).get('policy') || 'one';
    if (policy === 'auto') return this.commit(d, proposal.id, { id: 'policy', name: 'auto-policy', kind: 'system' });
    return outcome(true, 'pending', `Proposal ${proposal.id} is waiting for review (${POLICIES[policy]}). You'll get an inbox event if it is held or rejected.`, { proposalId: proposal.id });
  }

  required(d) {
    const policy = metaOf(d.ydoc).get('policy') || 'one';
    if (policy === 'auto') return 0;
    if (policy === 'one') return 1;
    return Math.floor(this.onlineHumans(d.spaceId).length / 2) + 1;
  }

  vote(spaceId, docId, proposalId, human, vote) {
    const d = this.doc(spaceId, docId);
    const p = proposalsOf(d.ydoc).get(proposalId);
    if (!p) throw new Error('no such proposal');
    if (p.status === 'held' && vote === 'reject') return this.finish(d, proposalId, 'rejected', human, 'dismissed after it was held');
    if (p.status !== 'pending') return outcome(false, p.status, `Proposal is already ${p.status}.`);
    const votes = { ...p.votes, [human.id]: { vote, name: human.name, color: human.color, ts: Date.now() } };
    d.ydoc.transact(() => proposalsOf(d.ydoc).set(proposalId, { ...p, votes }), 'hub');
    return this.tally(d, proposalId, human);
  }

  tally(d, proposalId, actor) {
    const p = proposalsOf(d.ydoc).get(proposalId);
    const need = this.required(d);
    const accepts = Object.values(p.votes).filter((v) => v.vote === 'accept').length;
    const rejects = Object.values(p.votes).filter((v) => v.vote === 'reject').length;
    if (accepts >= need) return this.commit(d, proposalId, actor);
    if (rejects >= need) return this.finish(d, proposalId, 'rejected', actor, 'rejected by reviewers');
    return outcome(true, 'pending', `${accepts}/${need} approvals.`);
  }

  reconsiderPending(d) {
    for (const [id, p] of proposalsOf(d.ydoc).entries()) if (p.status === 'pending') this.tally(d, id, { id: 'policy', name: 'policy', kind: 'system' });
  }

  finish(d, proposalId, status, actor, reason, extra = {}) {
    const p = proposalsOf(d.ydoc).get(proposalId);
    d.ydoc.transact(() => proposalsOf(d.ydoc).set(proposalId, { ...p, status, reason, resolvedAt: Date.now(), resolvedBy: actor.name, ...extra }), 'hub');
    this.appendLog(d, actor, 'proposal', `${status} ${p.author.name}’s proposal${reason ? ` (${reason})` : ''}`, { proposalId });
    if (status !== 'committed')
      this.deliver(p.author.id, {
        kind: 'proposal',
        target: `doc:${d.docId}`,
        docId: d.docId,
        proposalId,
        from: { id: actor.id, name: actor.name, kind: actor.kind },
        text: `Your ${p.kind} proposal ${proposalId} was ${status}: ${reason}.${extra.current !== undefined ? ` Current text of ${p.blockId}: ${extra.current}` : ''}`,
        flags: [status],
        hop: 0,
      });
    return outcome(status === 'committed', status, `Proposal ${proposalId} ${status}${reason ? `: ${reason}` : ''}.`, { proposalId });
  }

  // Apply an approved proposal. Edits are re-merged against whatever the block says *now*,
  // so humans who kept typing while the vote was open don't lose anything.
  commit(d, proposalId, actor) {
    const p = proposalsOf(d.ydoc).get(proposalId);
    if (p.kind === 'edit') {
      const found = findBlock(d.ydoc, p.blockId);
      if (!found) return this.finish(d, proposalId, 'rejected', actor, 'the block was deleted');
      const ytext = found.block.get('text');
      const current = ytext.toString();
      const m = merge3(p.baseText, p.newText, current);
      if (!m.ok) return this.finish(d, proposalId, 'held', actor, 'the block changed in the same words since it was proposed', { current });
      d.ydoc.transact(() => {
        applyTextMinimal(ytext, m.text);
        if (p.newType) found.block.set('type', p.newType);
      }, 'hub');
      return this.finish(d, proposalId, 'committed', actor, m.clean ? '' : 'merged with concurrent edits', { applied: m.text });
    }
    if (p.kind === 'insert') {
      const arr = blocksOf(d.ydoc);
      const after = p.afterBlockId ? findBlock(d.ydoc, p.afterBlockId) : null;
      const at = p.afterBlockId ? (after ? after.index + 1 : arr.length) : 0;
      d.ydoc.transact(() => arr.insert(at, p.blocks.map((b) => makeBlock(b.type, b.text))), 'hub');
      return this.finish(d, proposalId, 'committed', actor, '');
    }
    if (p.kind === 'delete') {
      const found = findBlock(d.ydoc, p.blockId);
      if (!found) return this.finish(d, proposalId, 'committed', actor, 'already gone');
      if (blocksOf(d.ydoc).length === 1) return this.finish(d, proposalId, 'rejected', actor, 'cannot delete the last block');
      d.ydoc.transact(() => blocksOf(d.ydoc).delete(found.index, 1), 'hub');
      return this.finish(d, proposalId, 'committed', actor, '');
    }
  }

  withdraw(spaceId, docId, agent, proposalId) {
    const d = this.doc(spaceId, docId);
    const p = proposalsOf(d.ydoc).get(proposalId);
    if (!p || p.author.id !== agent.id) return outcome(false, 'not_found', 'No such proposal of yours.');
    if (p.status !== 'pending' && p.status !== 'held') return outcome(false, p.status, `Already ${p.status}.`);
    return this.finish(d, proposalId, 'withdrawn', agent, 'withdrawn by its author');
  }

  // Ask an agent to do something about a doc (the "Ask" / "Review" buttons in the UI).
  ask(spaceId, docId, agentId, human, request) {
    const s = this.space(spaceId);
    if (agentId === '*') return this.createThread(spaceId, docId, human, { text: `@agents ${request}` });
    const a = s.agents.find((x) => x.id === agentId);
    if (!a) throw new Error('no such agent');
    return this.createThread(spaceId, docId, human, { text: `@${a.name} ${request}` });
  }

  close() {
    clearInterval(this.sweeper);
    this.store.flush();
  }
}
