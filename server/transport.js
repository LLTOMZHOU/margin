// Transport-agnostic sessions. A "sock" is anything with send(string) and close(code, reason);
// Node (ws) and Cloudflare Durable Objects (WebSocketPair) both adapt to it.
import * as Y from 'yjs';
import { HUMAN_COLORS } from './hub.js';
import { toB64, fromB64 } from '../src/shared/schema.js';

export function computerSession(hub, sock, log = () => {}) {
  const conn = { send: (m) => sock.send(JSON.stringify(m)) };
  hub.attachComputer(conn);
  log('local computer connected');
  return { onMessage() {}, onClose: () => hub.detachComputer(conn) };
}

let connSeq = 0;
export function humanSession(hub, sock) {
  const conn = {
    id: ++connSeq,
    spaceId: null,
    user: null,
    docs: new Set(),
    sendRaw: (s) => sock.send(s),
  };
  const send = (m) => conn.sendRaw(JSON.stringify(m));

  const leaveDoc = (docId) => {
    const d = hub.docs.get(conn.spaceId + '/' + docId);
    if (!d) return;
    d.conns.delete(conn);
    d.presence.delete(conn.id);
    conn.docs.delete(docId);
    hub.broadcastPresence(d);
  };

  const onMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.t === 'hello') {
        const u = msg.user || {};
        conn.user = {
          id: String(u.id || 'h' + conn.id).slice(0, 40),
          name: String(u.name || 'Guest').slice(0, 40),
          color: /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : HUMAN_COLORS[conn.id % HUMAN_COLORS.length],
          kind: 'human',
        };
        conn.spaceId = hub.space(msg.spaceId || hub.spaces.keys().next().value).id; // no spaceId: the first space
        hub.humanConns.add(conn);
        hub.touchHuman(conn.spaceId, conn.user);
        send({ t: 'space', space: hub.publicSpace(conn.spaceId) });
        hub.broadcastSpace(conn.spaceId);
        return;
      }
      if (!conn.spaceId) return;
      if (msg.t === 'join') {
        const d = hub.doc(conn.spaceId, msg.docId);
        d.conns.add(conn);
        conn.docs.add(msg.docId);
        d.presence.set(conn.id, { ...conn.user, connId: conn.id, blockId: null });
        const sv = msg.sv ? fromB64(msg.sv) : undefined;
        send({ t: 'sync', docId: msg.docId, u: toB64(Y.encodeStateAsUpdate(d.ydoc, sv)), sv: toB64(Y.encodeStateVector(d.ydoc)) });
        hub.broadcastPresence(d);
      } else if (msg.t === 'leave') {
        leaveDoc(msg.docId);
      } else if (msg.t === 'up') {
        const d = hub.doc(conn.spaceId, msg.docId);
        if (!d.conns.has(conn)) return;
        Y.applyUpdate(d.ydoc, fromB64(msg.u), conn);
      } else if (msg.t === 'presence') {
        const d = hub.doc(conn.spaceId, msg.docId);
        d.presence.set(conn.id, { ...conn.user, connId: conn.id, ...(msg.p || {}) });
        hub.broadcastPresence(d);
      } else if (msg.t === 'rpc') {
        try {
          send({ t: 'rpc', id: msg.id, ok: true, r: rpc(hub, conn, msg.m, msg.a || {}) });
        } catch (e) {
          send({ t: 'rpc', id: msg.id, ok: false, e: e.message });
        }
      }
    } catch (e) {
      send({ t: 'event', kind: 'error', text: e.message });
    }
  };

  const onClose = () => {
    for (const docId of [...conn.docs]) leaveDoc(docId);
    hub.humanConns.delete(conn);
    if (conn.spaceId) {
      hub.broadcastSpace(conn.spaceId);
      // fewer humans online can change what "majority" means
      for (const d of hub.docs.values()) if (d.spaceId === conn.spaceId) hub.reconsiderPending(d);
    }
  };
  return { onMessage, onClose };
}

function rpc(hub, conn, m, a) {
  const sid = conn.spaceId;
  const me = conn.user;
  switch (m) {
    case 'doc.create':
      return { docId: hub.createDoc(sid, { title: String(a.title || 'Untitled doc').slice(0, 120) }) };
    case 'doc.remove':
      return hub.removeDoc(sid, a.docId, me);
    case 'doc.policy':
      return hub.setPolicy(sid, a.docId, a.policy, me);
    case 'space.instructions':
      return hub.setInstructions(sid, a.text);
    case 'thread.create':
      return hub.createThread(sid, a.docId, me, { blockId: a.blockId, start: a.start, end: a.end, quote: a.quote, text: a.text });
    case 'thread.post':
      return hub.postMessage(sid, a.docId, a.threadId, me, { text: a.text });
    case 'thread.resolve':
      return hub.resolveThread(sid, a.docId, a.threadId, a.resolved, me);
    case 'proposal.vote':
      return hub.vote(sid, a.docId, a.proposalId, me, a.vote === 'reject' ? 'reject' : 'accept');
    case 'agent.create': {
      const agent = hub.createAgent(sid, a);
      const token = agent.host === 'external' ? hub.mintToken(sid, agent.id, 'external') : null;
      return { agentId: agent.id, token };
    }
    case 'agent.update':
      return hub.updateAgent(sid, a.agentId, a), null;
    case 'agent.remove':
      return hub.removeAgent(sid, a.agentId);
    case 'agent.mint':
      return { token: hub.mintToken(sid, a.agentId, 'external') };
    case 'agent.revoke':
      return hub.revokeToken(sid, a.agentId, a.prefix);
    case 'agent.ask':
      return hub.ask(sid, a.docId, a.agentId, me, String(a.request || 'please review this doc'));
    default:
      throw new Error('unknown method ' + m);
  }
}

