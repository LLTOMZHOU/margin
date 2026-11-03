// The bridge: keeps a wake-hint stream open for one agent and runs its runtime when woken.
// It never carries message bodies; the runtime pulls them from the inbox itself.
//   - wakes in one debounce window are coalesced into one run
//   - only one run at a time; a wake during a run schedules exactly one more run
//   - a slow poll is the fallback if the stream drops
//   - status is reported around every run (thinking -> online, or error)
import WebSocket from 'ws';
import { AgentClient } from './client.js';

export class Bridge {
  constructor({ server, token, agent, runtime, log = console.log, debounceMs = 600, pollMs = 60_000, env = {} }) {
    this.server = server;
    this.token = token;
    this.agent = agent; // { id, name, description, runtime }
    this.runtime = runtime; // { run(ctx) }
    this.api = new AgentClient({ server, token });
    this.log = (...a) => log(`[${agent.name}]`, ...a);
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    this.env = env;
    this.running = false;
    this.dirty = false;
    this.stopped = false;
    this.lastWake = null;
  }

  start() {
    this.connect();
    this.poller = setInterval(() => this.wake({ type: 'poll' }), this.pollMs);
    return this;
  }

  connect() {
    if (this.stopped) return;
    const url = this.server.replace(/^http/, 'ws') + '/api/agent/stream';
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer ' + this.token } });
    this.ws = ws;
    ws.on('open', () => this.api.status('online'));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'wake') this.wake(m);
      if (m.type === 'hello' && m.pendingCount) this.wake({ type: 'wake', flags: ['replay'], pendingCount: m.pendingCount });
    });
    ws.on('close', (code) => {
      if (code === 4001) {
        this.log('credential revoked or agent removed; stopping');
        return this.stop();
      }
      if (!this.stopped) setTimeout(() => this.connect(), 1500);
    });
    ws.on('error', () => {});
  }

  wake(hint) {
    this.lastWake = hint;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runOnce(), hint.type === 'poll' ? 0 : this.debounceMs);
  }

  async runOnce() {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      // The poll fallback only runs the model if something is actually waiting.
      if (this.lastWake?.type === 'poll') {
        const peek = await this.api.inbox();
        if (!peek.data?.events?.length) return;
      }
      await this.api.status('thinking', 'reading inbox');
      await this.runtime.run({ api: this.api, agent: this.agent, hint: this.lastWake, log: this.log, env: this.env });
      await this.api.status('online');
    } catch (e) {
      this.log('run failed:', e.message);
      await this.api.status('error', e.message.slice(0, 200));
    } finally {
      this.running = false;
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        this.runOnce();
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.poller);
    clearTimeout(this.timer);
    try {
      await this.api.status('offline');
    } catch {}
    this.ws?.close();
  }
}

// Shared loop for runtimes that read the inbox through the API (sim, claude-api).
// A batch is acknowledged only after it is handled, by passing its cursor on the next pull,
// so a crash mid-batch means the same batch comes back instead of being lost.
export async function drainInbox(api, handleBatch) {
  let since;
  for (let i = 0; i < 50; i++) {
    const r = await api.inbox(since);
    if (!r.ok) throw new Error(r.text);
    if (!r.data.events.length) return;
    await handleBatch(r.data.events, r);
    since = r.data.cursor;
  }
}
