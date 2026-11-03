// Disk persistence: one folder per space with space.json, one .ydoc per doc, one inbox file per agent.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'spaces'), { recursive: true });
    this.timers = new Map();
  }

  spaceDir(spaceId) {
    const d = path.join(this.dir, 'spaces', spaceId);
    fs.mkdirSync(path.join(d, 'inbox'), { recursive: true });
    return d;
  }

  listSpaces() {
    return fs
      .readdirSync(path.join(this.dir, 'spaces'))
      .filter((id) => fs.existsSync(path.join(this.dir, 'spaces', id, 'space.json')));
  }

  readJSON(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJSONAtomic(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  loadSpace(spaceId) {
    return this.readJSON(path.join(this.spaceDir(spaceId), 'space.json'), null);
  }

  saveSpace(space) {
    this.debounce('space:' + space.id, () => this.writeJSONAtomic(path.join(this.spaceDir(space.id), 'space.json'), space));
  }

  loadDoc(spaceId, docId) {
    const f = path.join(this.spaceDir(spaceId), docId + '.ydoc');
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  }

  saveDoc(spaceId, docId, getBytes) {
    this.debounce('doc:' + spaceId + docId, () => {
      const f = path.join(this.spaceDir(spaceId), docId + '.ydoc');
      fs.writeFileSync(f + '.tmp', getBytes());
      fs.renameSync(f + '.tmp', f);
    });
  }

  deleteDoc(spaceId, docId) {
    clearTimeout(this.timers.get('doc:' + spaceId + docId));
    this.timers.delete('doc:' + spaceId + docId);
    this.pendingFns?.delete('doc:' + spaceId + docId);
    fs.rmSync(path.join(this.spaceDir(spaceId), docId + '.ydoc'), { force: true });
  }

  loadInbox(spaceId, agentId) {
    return this.readJSON(path.join(this.spaceDir(spaceId), 'inbox', agentId + '.json'), { nextSeq: 1, acked: 0, events: [] });
  }

  saveInbox(spaceId, agentId, inbox) {
    this.debounce('inbox:' + agentId, () =>
      this.writeJSONAtomic(path.join(this.spaceDir(spaceId), 'inbox', agentId + '.json'), inbox),
    );
  }

  debounce(key, fn, ms = 250) {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
    this.pendingFns = this.pendingFns || new Map();
    this.pendingFns.set(key, fn);
  }

  flush() {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      this.pendingFns.get(key)?.();
    }
    this.timers.clear();
  }
}
