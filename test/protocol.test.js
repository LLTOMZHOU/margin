// The agent contract, borrowed from Raft's external agents, checked against the real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, human, agent, stream, until, sleep } from './helpers.js';
import { snapshot, findBlock, proposalsOf, threadsOf, encodeRel } from '../src/shared/schema.js';

let ctx;
test.before(async () => (ctx = await boot()));
test.after(async () => ctx.srv.close());

const firstPara = (d) => snapshot(d.ydoc).find((b) => b.type === 'p');

test('wake hints are content-free; bodies only come from the inbox', async () => {
  const { a, token, api } = agent(ctx, 'Wakey');
  const s = stream(ctx, token);
  await s.open;
  const h = await human(ctx, 'Ada');
  await h.c.rpc('thread.create', { docId: ctx.docId, text: '@Wakey secret plan: ship on Friday' });
  const wake = await until(() => s.msgs.find((m) => m.type === 'wake'));
  assert.ok(!JSON.stringify(wake).includes('secret'), 'wake hint must not carry the message body');
  assert.equal(wake.flags.includes('mention'), true);
  const r = await api.inbox();
  assert.match(r.text, /secret plan/);
  s.ws.close();
  h.c.close();
});

test('a pull acknowledges nothing; passing the cursor does', async () => {
  const { api } = agent(ctx, 'Cursor');
  const h = await human(ctx, 'Ada2');
  for (let i = 0; i < 3; i++) await h.c.rpc('thread.create', { docId: ctx.docId, text: `@Cursor task ${i}` });
  const first = await api.inbox();
  assert.equal(first.data.events.length, 3);
  // "crash" before acknowledging: the same batch comes back
  const again = await api.inbox();
  assert.deepEqual(again.data.events.map((e) => e.seq), first.data.events.map((e) => e.seq));
  // acknowledge by sending the cursor
  const after = await api.inbox(first.data.cursor);
  assert.equal(after.data.events.length, 0);
  assert.equal(after.state, 'empty');
  h.c.close();
});

test('a reply is held when the thread moved on, and resent with its idempotency key', async () => {
  const { api } = agent(ctx, 'Replier');
  const h = await human(ctx, 'Ada3');
  const { threadId } = await h.c.rpc('thread.create', { docId: ctx.docId, text: '@Replier what do you think?' });
  const read = await api.thread(ctx.docId, threadId);
  await h.c.rpc('thread.post', { docId: ctx.docId, threadId, text: 'actually, never mind, focus on pricing' });
  const held = await api.reply(ctx.docId, threadId, { text: 'I think it is fine', seen_through: read.data.seenThrough });
  assert.equal(held.state, 'interrupted');
  assert.match(held.text, /focus on pricing/);
  const t = () => threadsOf(h.d.ydoc).get(threadId).get('messages').toArray();
  assert.equal(t().length, 2, 'held reply must not be posted');
  const sent = await api.reply(ctx.docId, threadId, { text: 'Then: price per seat.', idempotency_key: held.data.interrupt.resume.idempotencyKey });
  assert.equal(sent.state, 'sent');
  const dup = await api.reply(ctx.docId, threadId, { text: 'Then: price per seat.', idempotency_key: held.data.interrupt.resume.idempotencyKey });
  assert.equal(dup.state, 'sent');
  await until(() => t().length === 3);
  await sleep(100);
  assert.equal(t().length, 3, 'retrying with the same key must not double-post');
  h.c.close();
});

test('an agent edit merges with concurrent human typing; same-word conflicts are held', async () => {
  const { api } = agent(ctx, 'Merger');
  const h = await human(ctx, 'Ada4');
  await h.c.rpc('doc.policy', { docId: ctx.docId, policy: 'one' });
  const doc = await api.doc(ctx.docId);
  const b = doc.data.blocks.find((x) => x.text.includes('basically'));
  const agentText = b.text.replace('basically ', '');
  // human edits a different part of the block before the agent proposes
  const yt = findBlock(h.d.ydoc, b.id).block.get('text');
  h.d.ydoc.transact(() => yt.insert(yt.length, ' (Ada was here)'));
  await until(() => ctx.hub.doc(ctx.space.id, ctx.docId) && findBlock(ctx.hub.doc(ctx.space.id, ctx.docId).ydoc, b.id).block.get('text').toString().endsWith('(Ada was here)'));
  const p = await api.propose(ctx.docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: agentText, rationale: 'cut filler' });
  assert.equal(p.state, 'pending');
  // human keeps typing while the vote is open
  h.d.ydoc.transact(() => yt.insert(0, 'Today, '));
  await sleep(100);
  await h.c.rpc('proposal.vote', { docId: ctx.docId, proposalId: p.data.proposalId, vote: 'accept' });
  await until(() => yt.toString().startsWith('Today, Research teams are drowning'));
  assert.ok(yt.toString().endsWith('(Ada was here)'));
  assert.ok(!yt.toString().includes('basically'));

  // same words changed by both: proposal creation is interrupted
  const now = yt.toString();
  const p2 = await api.propose(ctx.docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: b.text.replace('Research teams', 'Lab teams'), rationale: 'x' });
  assert.ok(now.includes('Research teams'));
  assert.equal(p2.ok, true, 'non-overlapping with the human edits, so it should merge');
  const base3 = yt.toString();
  const p3 = await api.propose(ctx.docId, { kind: 'edit', block_id: b.id, base_text: base3, text: base3.replace('Today,', 'Right now,'), rationale: 'y' });
  h.d.ydoc.transact(() => {
    yt.delete(0, 'Today,'.length);
    yt.insert(0, 'These days,');
  });
  await sleep(100);
  const res = await h.c.rpc('proposal.vote', { docId: ctx.docId, proposalId: p3.data.proposalId, vote: 'accept' });
  assert.equal(res.state, 'held', 'conflicting proposal must be held, not applied over the human');
  assert.ok(yt.toString().startsWith('These days,'));
  h.c.close();
});

test('leases keep two agents off the same block', async () => {
  const one = agent(ctx, 'LeaseOne');
  const two = agent(ctx, 'LeaseTwo');
  const doc = await one.api.doc(ctx.docId);
  const b = doc.data.blocks.find((x) => x.type === 'li');
  assert.equal((await one.api.lease(ctx.docId, [b.id])).ok, true);
  const blocked = await two.api.lease(ctx.docId, [b.id]);
  assert.equal(blocked.state, 'leased');
  const p = await two.api.propose(ctx.docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: b.text + '!', rationale: 'z' });
  assert.equal(p.state, 'leased');
  await one.api.status('online'); // end of run releases leases
  assert.equal((await two.api.lease(ctx.docId, [b.id])).ok, true);
});

test('majority policy needs a majority of the humans online', async () => {
  const { api } = agent(ctx, 'Voter');
  const hs = [await human(ctx, 'H1'), await human(ctx, 'H2'), await human(ctx, 'H3')];
  await hs[0].c.rpc('doc.policy', { docId: ctx.docId, policy: 'majority' });
  const doc = await api.doc(ctx.docId);
  const b = doc.data.blocks.find((x) => x.type === 'h2');
  const p = await api.propose(ctx.docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: b.text + ' (draft)', rationale: 'mark' });
  const r1 = await hs[0].c.rpc('proposal.vote', { docId: ctx.docId, proposalId: p.data.proposalId, vote: 'accept' });
  assert.equal(r1.state, 'pending');
  const r2 = await hs[1].c.rpc('proposal.vote', { docId: ctx.docId, proposalId: p.data.proposalId, vote: 'accept' });
  assert.equal(r2.state, 'committed');
  await hs[0].c.rpc('doc.policy', { docId: ctx.docId, policy: 'one' });
  hs.forEach((h) => h.c.close());
});

test('revoking a credential closes the wake stream and rejects calls', async () => {
  const { a, token, api } = agent(ctx, 'Revokee');
  const s = stream(ctx, token);
  await s.open;
  ctx.hub.revokeToken(ctx.space.id, a.id, token.slice(0, 16));
  assert.equal(await s.closed, 4001);
  const r = await api.whoami();
  assert.equal(r.state, 'unauthorized');
});

test('agent-to-agent mentions stop after a few hops', async () => {
  const x = agent(ctx, 'PingA');
  const y = agent(ctx, 'PingB');
  const h = await human(ctx, 'Ada5');
  const { threadId } = await h.c.rpc('thread.create', { docId: ctx.docId, text: '@PingA start' });
  let hop = 0;
  for (let i = 0; i < 6; i++) {
    const [me, other] = i % 2 ? [y, x] : [x, y];
    const ib = await me.api.inbox();
    const ev = ib.data.events.at(-1);
    if (!ev) break;
    await me.api.inbox(ib.data.cursor);
    hop = ev.hop;
    await me.api.reply(ctx.docId, threadId, { text: `@${other.a.name} your turn`, hop: ev.hop });
  }
  assert.ok(hop <= 3, `loop must be cut off, reached hop ${hop}`);
  const last = await y.api.inbox();
  const lastX = await x.api.inbox();
  assert.ok(last.data.events.length + lastX.data.events.length <= 1);
  h.c.close();
});

test('an agent shows offline as soon as its session ends or it reports offline', async () => {
  const { a, token, api } = agent(ctx, 'Presence');
  const status = () => ctx.hub.publicSpace(ctx.space.id).agents.find((x) => x.id === a.id).status;
  const s = stream(ctx, token);
  await s.open;
  await until(() => status() === 'online');
  await api.status('offline');
  assert.equal(status(), 'offline', 'a reported offline wins even while the stream is open');
  await api.status('online');
  assert.equal(status(), 'online');
  s.ws.close();
  await until(() => status() === 'offline', 2000);
});

test('deleting a doc removes it for everyone but a space keeps at least one', async () => {
  const h = await human(ctx, 'Deleter');
  const { docId } = await h.c.rpc('doc.create', { title: 'Scratch' });
  assert.ok(ctx.hub.space(ctx.space.id).docs.some((d) => d.id === docId));
  await h.c.rpc('doc.remove', { docId });
  assert.ok(!ctx.hub.space(ctx.space.id).docs.some((d) => d.id === docId));
  h.c.close();
});

test('per-wake scope: an agent may only act where the request that woke it points', async () => {
  const { a, api } = agent(ctx, 'Scoped', 'test', 'external', 'wake');
  const h = await human(ctx, 'Asker');
  const blocks = snapshot(h.d.ydoc).filter((b) => b.type === 'p');
  const [b1, b2] = blocks;
  const yt = findBlock(h.d.ydoc, b1.id).block.get('text');
  const { threadId } = await h.c.rpc('thread.create', {
    docId: ctx.docId, blockId: b1.id, start: encodeRel(yt, 0), end: encodeRel(yt, 5, -1), quote: b1.text.slice(0, 5), text: '@Scoped tighten this',
  });
  const other = await h.c.rpc('thread.create', { docId: ctx.docId, text: 'a different conversation' });

  // the grant arrives with the event, so in-scope actions work right away
  const ib = await api.inbox();
  assert.match(ib.text, /you may: reply in/);
  assert.equal((await api.propose(ctx.docId, { kind: 'edit', block_id: b1.id, base_text: b1.text, text: b1.text + '.', rationale: 'ok' })).state, 'pending');
  assert.equal((await api.reply(ctx.docId, threadId, { text: 'done' })).state, 'sent');

  // everything else is refused by the hub, whatever the agent was told
  assert.equal((await api.propose(ctx.docId, { kind: 'edit', block_id: b2.id, base_text: b2.text, text: 'pwned', rationale: 'x' })).state, 'out_of_scope');
  assert.equal((await api.reply(ctx.docId, other.threadId, { text: 'pwned' })).state, 'out_of_scope');
  assert.equal((await api.comment(ctx.docId, { block_id: b2.id, quote: '', text: 'pwned' })).state, 'out_of_scope');
  assert.equal((await api.lease(ctx.docId, [b2.id])).state, 'out_of_scope');
  const second = ctx.hub.createDoc(ctx.space.id, { title: 'Elsewhere' });
  assert.equal((await api.propose(second, { kind: 'insert', after_block_id: null, blocks: [{ type: 'p', text: 'pwned' }] })).state, 'out_of_scope');

  // a doc-level ask grants the whole doc, still not other threads or docs
  await h.c.rpc('agent.ask', { docId: ctx.docId, agentId: a.id, request: 'review please' });
  await api.inbox(ib.data.cursor);
  assert.equal((await api.propose(ctx.docId, { kind: 'edit', block_id: b2.id, base_text: b2.text, text: b2.text + '!', rationale: 'ok' })).state, 'pending');
  assert.equal((await api.reply(ctx.docId, other.threadId, { text: 'still no' })).state, 'out_of_scope');
  h.c.close();
});

test('grants persist with the inbox across a hub restart', async () => {
  const { a, token } = agent(ctx, 'Restarted', 'test', 'external', 'wake');
  const h = await human(ctx, 'Asker2');
  const { threadId } = await h.c.rpc('thread.create', { docId: ctx.docId, text: '@Restarted hi' });
  ctx.hub.store.flush();
  const { Hub } = await import('../server/hub.js');
  const fresh = new Hub(ctx.hub.store);
  const auth = fresh.authenticate(token);
  assert.equal(fresh.agentReply(ctx.space.id, ctx.docId, threadId, auth.agent, { text: 'still allowed' }).state, 'sent');
  fresh.close();
  h.c.close();
});
