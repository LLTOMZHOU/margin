// Thin client for the agent API. Every method resolves to an outcome { ok, state, text, data, next }.
import { uid } from '../shared/schema.js';

export class AgentClient {
  constructor({ server, token }) {
    if (!server || !token) throw new Error('AgentClient needs server and token');
    this.server = server.replace(/\/$/, '');
    this.token = token;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await fetch(this.server + '/api/agent' + path, {
        method,
        headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs || 20_000),
      });
    } catch (e) {
      return { ok: false, state: 'unreachable', text: `Cannot reach ${this.server}: ${e.message}` };
    }
    try {
      return await res.json();
    } catch {
      return { ok: false, state: 'error', text: `HTTP ${res.status}` };
    }
  }

  whoami() { return this.call('GET', '/whoami'); }
  manual() { return this.call('GET', '/manual'); }
  inbox(since) { return this.call('GET', '/inbox' + (since !== undefined && since !== null ? `?since=${since}` : '')); }
  docs() { return this.call('GET', '/docs'); }
  doc(docId) { return this.call('GET', `/doc/${docId}`); }
  thread(docId, threadId) { return this.call('GET', `/thread/${docId}/${threadId}`); }
  reply(docId, threadId, body) { return this.call('POST', `/thread/${docId}/${threadId}/reply`, body); }
  comment(docId, body) { return this.call('POST', `/comment/${docId}`, body); }
  propose(docId, body) { return this.call('POST', `/propose/${docId}`, body); }
  withdraw(docId, proposalId) { return this.call('POST', `/proposal/${docId}/${proposalId}/withdraw`); }
  lease(docId, blockIds, ttlMs) { return this.call('POST', `/lease/${docId}`, { block_ids: blockIds, ttl_ms: ttlMs }); }
  release(docId) { return this.call('DELETE', `/lease/${docId}`); }
  status(status, detail = '') {
    return this.call('POST', '/status', { eventId: uid('e'), occurredAt: new Date().toISOString(), status, detail: detail.slice(0, 200) });
  }
}

// Parse "thread:<doc>/<thread>" and "doc:<doc>" targets.
export function parseTarget(target) {
  if (!target) return {};
  const [kind, rest] = target.split(':');
  if (kind === 'thread') {
    const [docId, threadId] = rest.split('/');
    return { docId, threadId };
  }
  if (kind === 'doc') return { docId: rest };
  return {};
}
