// Human-side connection to the hub. Same code runs in the browser and in the fuzz tests.
// One WebSocket carries the space feed, any number of Yjs doc rooms, presence, and RPC.
import * as Y from 'yjs';
import { toB64, fromB64 } from './schema.js';

export class HubClient {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, user, spaceId }) {
    this.url = url;
    this.WS = WebSocketImpl;
    this.user = user;
    this.spaceId = spaceId;
    this.docs = new Map(); // docId -> { ydoc, synced, presence, leases, listeners }
    this.pending = new Map();
    this.rpcSeq = 0;
    this.space = null;
    this.spaceListeners = new Set();
    this.statusListeners = new Set();
    this.eventListeners = new Set();
    this.status = 'connecting';
    this.closed = false;
    this.outbox = [];
    this.connect();
  }

  connect() {
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus('online');
      this.raw({ t: 'hello', user: this.user, spaceId: this.spaceId });
      for (const [docId, d] of this.docs) {
        d.synced = false;
        this.raw({ t: 'join', docId, sv: toB64(Y.encodeStateVector(d.ydoc)) });
      }
      const queued = this.outbox;
      this.outbox = [];
      queued.forEach((m) => this.raw(m));
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
    ws.onclose = () => {
      this.setStatus('offline');
      for (const [, p] of this.pending) p.reject(new Error('disconnected'));
      this.pending.clear();
      if (!this.closed) setTimeout(() => this.connect(), 800);
    };
    ws.onerror = () => {};
  }

  setStatus(s) {
    this.status = s;
    this.statusListeners.forEach((f) => f(s));
  }

  raw(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'presence') this.outbox.push(msg);
  }

  close() {
    this.closed = true;
    this.ws.close();
  }

  rpc(m, a = {}) {
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: 'rpc', id, m, a });
    });
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'space':
        this.space = msg.space;
        this.spaceListeners.forEach((f) => f(msg.space));
        break;
      case 'sync': {
        const d = this.docs.get(msg.docId);
        if (!d) return;
        Y.applyUpdate(d.ydoc, fromB64(msg.u), 'remote');
        // send back whatever the hub is missing (offline edits made while disconnected)
        const missing = Y.encodeStateAsUpdate(d.ydoc, fromB64(msg.sv));
        if (missing.length > 2) this.send({ t: 'up', docId: msg.docId, u: toB64(missing) });
        d.synced = true;
        d.emit('synced');
        break;
      }
      case 'up': {
        const d = this.docs.get(msg.docId);
        if (d) Y.applyUpdate(d.ydoc, fromB64(msg.u), 'remote');
        break;
      }
      case 'presence': {
        const d = this.docs.get(msg.docId);
        if (d) {
          d.presence = msg.peers;
          d.emit('presence');
        }
        break;
      }
      case 'leases': {
        const d = this.docs.get(msg.docId);
        if (d) {
          d.leases = msg.leases;
          d.emit('leases');
        }
        break;
      }
      case 'rpc': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.r) : p.reject(new Error(msg.e));
        break;
      }
      case 'event':
        this.eventListeners.forEach((f) => f(msg));
        break;
    }
  }

  openDoc(docId) {
    if (this.docs.has(docId)) return this.docs.get(docId);
    const ydoc = new Y.Doc();
    const listeners = new Map();
    const d = {
      docId,
      ydoc,
      synced: false,
      presence: [],
      leases: [],
      on(ev, f) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(f);
        return () => listeners.get(ev).delete(f);
      },
      emit(ev) {
        listeners.get(ev)?.forEach((f) => f());
      },
      setPresence: (p) => this.send({ t: 'presence', docId, p }),
    };
    ydoc.on('update', (u, origin) => {
      if (origin !== 'remote') this.send({ t: 'up', docId, u: toB64(u) });
    });
    this.docs.set(docId, d);
    this.raw({ t: 'join', docId, sv: toB64(Y.encodeStateVector(ydoc)) });
    return d;
  }

  closeDoc(docId) {
    const d = this.docs.get(docId);
    if (!d) return;
    this.send({ t: 'leave', docId });
    d.ydoc.destroy();
    this.docs.delete(docId);
  }
}
