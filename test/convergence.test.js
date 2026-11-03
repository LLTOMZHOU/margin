// Fuzz: 10 humans and 10 agents hammer one doc at once. Afterwards every replica must be
// identical, every decision must be in the log exactly once, and no two agents may ever
// have held a lease on the same block at the same time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, human, agent, until, sleep } from './helpers.js';
import { AgentClient } from '../src/agent/client.js';
import { snapshot, blocksOf, proposalsOf, threadsOf, logOf, makeBlock, encodeRel } from '../src/shared/schema.js';

const HUMANS = Number(process.env.FUZZ_HUMANS || 10);
const AGENTS = Number(process.env.FUZZ_AGENTS || 10);
const DURATION = Number(process.env.FUZZ_MS || 5000);
// FUZZ_SEPARATE=1 runs the hub in its own process, like a real deployment, so the 25 replicas
// the harness simulates don't share a CPU core with the hub they're measuring.
const SEPARATE = process.env.FUZZ_SEPARATE === '1';

async function bootSeparate() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-fuzz-'));
  const port = 43000 + Math.floor(Math.random() * 2000);
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'margin.js');
  const proc = spawn(process.execPath, [...(process.env.FUZZ_NODE_ARGS ? process.env.FUZZ_NODE_ARGS.split(' ') : []), bin, 'serve', '--port', String(port), '--data', dataDir, '--no-computer'], { stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  await until(async () => (await fetch(url + '/api/health').catch(() => null))?.ok, 20000, 100);
  const space = (await (await fetch(url + '/api/spaces')).json())[0];
  return { srv: { url, close: async () => { proc.kill('SIGINT'); await new Promise((r) => proc.on('exit', r)); } }, space, wsUrl: url.replace('http', 'ws') + '/ws', docId: null, separate: true };
}
const rnd = (n) => Math.floor(Math.random() * n);
const WORDS = ['alpha', 'beta', 'notes', 'team', 'ship', 'draft', 'agent', 'lab', 'merge', 'quick'];

function humanStep(h, stats) {
  const arr = blocksOf(h.d.ydoc);
  if (!arr.length) return;
  const r = Math.random();
  const b = arr.get(rnd(arr.length));
  const t = b.get('text');
  h.d.ydoc.transact(() => {
    if (r < 0.55) t.insert(rnd(t.length + 1), ' ' + WORDS[rnd(WORDS.length)]);
    else if (r < 0.8 && t.length > 2) {
      const at = rnd(t.length - 1);
      t.delete(at, Math.min(1 + rnd(4), t.length - at));
    } else if (r < 0.9) arr.insert(rnd(arr.length + 1), [makeBlock('p', WORDS[rnd(WORDS.length)])]);
    else if (r < 0.95 && arr.length > 8) arr.delete(rnd(arr.length), 1);
    else b.set('type', ['p', 'li', 'h2'][rnd(3)]);
  });
  stats.humanOps++;
}

async function agentStep(ag, docId, stats) {
  const doc = await ag.api.doc(docId);
  const blocks = doc.data.blocks.filter((b) => b.text.length > 3);
  if (!blocks.length) return;
  const b = blocks[rnd(blocks.length)];
  const lease = await ag.api.lease(docId, [b.id], 2000);
  if (!lease.ok) return stats.leaseDenied++;
  stats.leaseGranted++;
  const r = Math.random();
  if (r < 0.6) {
    const words = b.text.split(' ');
    words[rnd(words.length)] = ag.a.name.toUpperCase();
    const p = await ag.api.propose(docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: words.join(' '), rationale: 'fuzz' });
    stats.proposals[p.state] = (stats.proposals[p.state] || 0) + 1;
  } else if (r < 0.8) {
    const p = await ag.api.propose(docId, { kind: 'insert', after_block_id: b.id, blocks: [{ type: 'p', text: `inserted by ${ag.a.name}` }], rationale: 'fuzz' });
    stats.proposals[p.state] = (stats.proposals[p.state] || 0) + 1;
  } else {
    await ag.api.comment(docId, { block_id: b.id, quote: b.text.slice(0, 6), text: 'fuzz comment' });
    stats.comments++;
  }
  await ag.api.release(docId);
}

test(`${HUMANS} humans + ${AGENTS} agents converge`, { timeout: 120_000 }, async (t) => {
  const ctx = SEPARATE ? await bootSeparate() : await boot();
  if (SEPARATE) {
    const { HubClient } = await import('../src/shared/sync.js');
    const WebSocket = (await import('ws')).default;
    const probe = new HubClient({ url: ctx.wsUrl, WebSocketImpl: WebSocket, user: { id: 'boot', name: 'boot' }, spaceId: ctx.space.id });
    await new Promise((r) => probe.spaceListeners.add(r));
    ctx.docId = probe.space.docs[0].id;
    ctx.bootClient = probe;
  }
  const humansToClose = [];
  t.after(async () => {
    humansToClose.forEach((h) => h.c.close());
    ctx.bootClient?.close();
    await ctx.srv.close();
  });
  const hub = ctx.hub;

  // Lease invariant monitor: wrap claimLease and check exclusivity at every grant (in-process only).
  const live = hub ? hub.doc(ctx.space.id, ctx.docId) : null;
  let leaseViolations = SEPARATE ? 'n/a (separate process)' : 0;
  const orig = hub?.claimLease.bind(hub);
  if (hub) hub.claimLease = (sid, did, ag, ids, ttl) => {
    const now = Date.now();
    const before = ids.map((id) => live.leases.get(id)).filter((l) => l && l.expires > now && l.agentId !== ag.id);
    const r = orig(sid, did, ag, ids, ttl);
    if (r.ok && before.length) leaseViolations++;
    return r;
  };

  const humans = [];
  for (let i = 0; i < HUMANS; i++) humans.push(await human(ctx, 'Human' + i));
  humansToClose.push(...humans);
  const agents = [];
  for (let i = 0; i < AGENTS; i++) {
    if (!SEPARATE) agents.push(agent(ctx, 'Bot' + i));
    else {
      const r = await humans[0].c.rpc('agent.create', { name: 'Bot' + i, runtime: 'external', scope: 'space' });
      agents.push({ a: { id: r.agentId, name: 'Bot' + i }, token: r.token, api: new AgentClient({ server: ctx.srv.url, token: r.token }) });
    }
  }
  await humans[0].c.rpc('doc.policy', { docId: ctx.docId, policy: 'one' });

  const stats = { humanOps: 0, leaseGranted: 0, leaseDenied: 0, comments: 0, proposals: {}, votes: 0, latency: [] };
  const stopAt = Date.now() + DURATION;

  // humans type ~every 30ms each, and vote on whatever is pending
  const humanLoops = humans.map(async (h) => {
    while (Date.now() < stopAt) {
      humanStep(h, stats);
      if (Math.random() < 0.05) {
        const pending = [...proposalsOf(h.d.ydoc).values()].filter((p) => p.status === 'pending');
        if (pending.length) {
          const p = pending[rnd(pending.length)];
          await h.c.rpc('proposal.vote', { docId: ctx.docId, proposalId: p.id, vote: Math.random() < 0.8 ? 'accept' : 'reject' }).catch(() => {});
          stats.votes++;
        }
      }
      if (Math.random() < 0.02) {
        const arr = blocksOf(h.d.ydoc);
        const b = arr.get(rnd(arr.length));
        const t = b.get('text');
        if (t.length > 4) await h.c.rpc('thread.create', { docId: ctx.docId, blockId: b.get('id'), start: encodeRel(t, 0), end: encodeRel(t, 3, -1), quote: t.toString().slice(0, 3), text: '@Bot1 look' }).catch(() => {});
      }
      await sleep(15 + rnd(30));
    }
  });
  const agentLoops = agents.map(async (ag) => {
    while (Date.now() < stopAt) {
      await agentStep(ag, ctx.docId, stats).catch((e) => (stats.agentErrors = (stats.agentErrors || 0) + 1));
      await sleep(rnd(40));
    }
  });

  // propagation latency probe: one human writes a marker, time until all others see it
  const probe = (async () => {
    for (let k = 0; Date.now() < stopAt - 300; k++) {
      const marker = `§${k}§`;
      const src = humans[k % humans.length];
      const t0 = performance.now();
      src.d.ydoc.transact(() => src.d.ydoc.getMap('probe').set('k', marker));
      await until(() => humans.every((h) => h.d.ydoc.getMap('probe').get('k') === marker), 5000, 1);
      stats.latency.push(performance.now() - t0);
      await sleep(80);
    }
  })();

  await Promise.all([...humanLoops, ...agentLoops, probe]);

  // quiesce: wait until every replica's state vector matches the hub's
  const { encodeStateVector } = await import('yjs');
  const sv = (d) => Buffer.from(encodeStateVector(d)).toString('base64');
  let ref_doc = live?.ydoc;
  if (SEPARATE) {
    // reference = a brand-new client that joins after the storm and syncs from the hub
    await sleep(500);
    const late = await human(ctx, 'Late');
    humansToClose.push(late);
    ref_doc = late.d.ydoc;
  }
  await until(() => humans.every((h) => sv(h.d.ydoc) === sv(ref_doc)), 15000, 20);

  const ref = JSON.stringify({
    blocks: snapshot(ref_doc),
    proposals: [...proposalsOf(ref_doc).values()].map((p) => [p.id, p.status]).sort(),
    threads: [...threadsOf(ref_doc).keys()].sort(),
    log: logOf(ref_doc).length,
  });
  for (const h of humans) {
    const mine = JSON.stringify({
      blocks: snapshot(h.d.ydoc),
      proposals: [...proposalsOf(h.d.ydoc).values()].map((p) => [p.id, p.status]).sort(),
      threads: [...threadsOf(h.d.ydoc).keys()].sort(),
      log: logOf(h.d.ydoc).length,
    });
    assert.equal(mine, ref, `${h.name} diverged`);
  }

  // every committed/rejected/held decision appears in the log exactly once, seqs contiguous
  const log = logOf(ref_doc).toArray();
  log.forEach((e, i) => assert.equal(e.seq, i + 1, 'log seq must be contiguous'));
  for (const p of proposalsOf(ref_doc).values()) {
    if (['committed', 'rejected', 'held'].includes(p.status)) {
      const n = log.filter((e) => e.proposalId === p.id && e.summary.startsWith(p.status)).length;
      assert.equal(n, 1, `proposal ${p.id} (${p.status}) should be logged once, got ${n}`);
    }
  }
  if (!SEPARATE) assert.equal(leaseViolations, 0, 'two agents held the same block at once');

  const lat = stats.latency.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]?.toFixed(1);
  const committed = [...proposalsOf(ref_doc).values()].filter((x) => x.status === 'committed').length;
  console.log(
    `\n  participants: ${HUMANS} humans + ${AGENTS} agents, ${DURATION}ms, hub ${SEPARATE ? 'in its own process' : 'in the test process'}\n` +
      `  human ops: ${stats.humanOps}, votes: ${stats.votes}, comments: ${stats.comments}\n` +
      `  proposals: ${JSON.stringify(stats.proposals)}, committed: ${committed}\n` +
      `  leases granted: ${stats.leaseGranted}, denied (contention): ${stats.leaseDenied}, violations: ${leaseViolations}\n` +
      `  fan-out latency to all ${HUMANS} humans: p50 ${p(0.5)}ms, p95 ${p(0.95)}ms, max ${p(1)}ms (n=${lat.length})\n` +
      `  final blocks: ${blocksOf(ref_doc).length}, log entries: ${log.length}, replicas identical: yes`,
  );
  assert.ok(Number(p(0.95)) < 50, `p95 fan-out latency ${p(0.95)}ms should be under 50ms`);
});
