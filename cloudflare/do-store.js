// Store backed by a SQLite Durable Object (same interface as server/store.js).
// One table, synchronous reads at construction time, debounced writes for hot docs.
export class DOStore {
  constructor(storage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB)');
    this.timers = new Map();
    this.pendingFns = new Map();
  }
  get(k) {
    const rows = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray();
    return rows.length ? rows[0].v : null;
  }
  put(k, v) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
  getJSON(k, d) {
    const v = this.get(k);
    return v === null ? d : JSON.parse(v);
  }
  listSpaces() {
    return this.sql.exec("SELECT k FROM kv WHERE k LIKE 'space:%'").toArray().map((r) => r.k.slice(6));
  }
  loadSpace(id) {
    return this.getJSON('space:' + id, null);
  }
  saveSpace(space) {
    this.debounce('space:' + space.id, () => this.put('space:' + space.id, JSON.stringify(space)), 50);
  }
  loadDoc(spaceId, docId) {
    const v = this.get(`doc:${spaceId}:${docId}`);
    return v ? new Uint8Array(v) : null;
  }
  saveDoc(spaceId, docId, getBytes) {
    this.debounce(`doc:${spaceId}:${docId}`, () => {
      const bytes = getBytes();
      if (bytes.byteLength > 1.9 * 1024 * 1024) console.warn(`doc ${docId} is ${bytes.byteLength} bytes; close to the 2MB row limit`);
      this.put(`doc:${spaceId}:${docId}`, bytes);
    });
  }
  deleteDoc(spaceId, docId) {
    const k = `doc:${spaceId}:${docId}`;
    clearTimeout(this.timers.get(k));
    this.timers.delete(k);
    this.pendingFns.delete(k);
    this.sql.exec('DELETE FROM kv WHERE k = ?', k);
  }
  loadInbox(spaceId, agentId) {
    return this.getJSON(`inbox:${spaceId}:${agentId}`, { nextSeq: 1, acked: 0, events: [] });
  }
  saveInbox(spaceId, agentId, inbox) {
    const { spaceId: _s, ...rest } = inbox;
    this.debounce('inbox:' + agentId, () => this.put(`inbox:${spaceId}:${agentId}`, JSON.stringify(rest)), 50);
  }
  debounce(key, fn, ms = 250) {
    clearTimeout(this.timers.get(key));
    this.pendingFns.set(key, fn);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.pendingFns.delete(key);
        fn();
      }, ms),
    );
  }
  flush() {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      this.pendingFns.get(key)?.();
    }
    this.timers.clear();
    this.pendingFns.clear();
  }
}
