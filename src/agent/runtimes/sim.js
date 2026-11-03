// Offline runtime: rule-based agents that use the exact same agent API a model would.
// Good enough to demo the protocol (leases, proposals, held edits, threads) with no API key.
import { drainInbox } from '../bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

const FILLER = [
  [/\bIn order to\b/g, 'To'],
  [/\bin order to\b/g, 'to'],
  [/\b(basically|really|very|just|actually|obviously|clearly|literally|quite)\s+/gi, ''],
  [/\bthat is very generous\b/gi, 'that is generous'],
  [/ {2,}/g, ' '],
  [/\s+([,.;:])/g, '$1'],
];

export function tighten(text) {
  let out = text;
  for (const [re, rep] of FILLER) out = out.replace(re, rep);
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return out.trim();
}

const sentences = (t) => t.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [];
const CLAIM = /(\d+(\.\d+)?\s?%|\b\d{2,}\b|studies show|research shows|everyone agrees|according to)/i;
const ABSOLUTE = /\b(never|always|everyone|no one|nobody|obviously|guaranteed|certainly|will never|the simplest|the best)\b/i;

function roleOf(agent) {
  const s = `${agent.name} ${agent.description}`.toLowerCase();
  if (/fact|verify|source/.test(s)) return 'fact';
  if (/skeptic|red team|devil|critic/.test(s)) return 'skeptic';
  if (/scribe|summar|draft|notes/.test(s)) return 'scribe';
  if (/edit|copy|line|tighten/.test(s)) return 'editor';
  return 'editor';
}

export const simRuntime = {
  name: 'sim',
  async run({ api, agent, log }) {
    const role = roleOf(agent);
    await drainInbox(api, async (events) => {
      for (const e of events) {
        try {
          if (e.kind === 'message') await handleMessage(api, agent, role, e, log);
          else if (e.kind === 'proposal' && e.flags?.includes('held')) await handleHeld(api, agent, e, log);
        } catch (err) {
          log('sim error:', err.message);
        }
      }
    });
  },
};

async function handleHeld(api, agent, e) {
  await api.status('working', 'rebasing a held edit');
  const doc = await api.doc(e.docId);
  const prop = doc.data.proposals.find((p) => p.id === e.proposalId);
  const block = prop && doc.data.blocks.find((b) => b.id === prop.blockId);
  if (!block) return;
  const next = tighten(block.text);
  if (next !== block.text) await api.propose(e.docId, { kind: 'edit', block_id: block.id, base_text: block.text, text: next, rationale: 'Re-proposed against the current text after my earlier edit was held.' });
}

async function reply(api, e, text, seen) {
  await sleep(jitter(250, 700));
  let r = await api.reply(e.docId, e.threadId, { text, seen_through: seen, hop: e.hop });
  if (r.state === 'interrupted') {
    // The thread moved on while we were "typing". Our reply is about the original ask, still valid: resend.
    r = await api.reply(e.docId, e.threadId, { text, idempotency_key: r.data.interrupt.resume.idempotencyKey, hop: e.hop });
  }
  return r;
}

async function handleMessage(api, agent, role, e, log) {
  const th = await api.thread(e.docId, e.threadId);
  if (!th.ok) return;
  const seen = th.data.seenThrough;
  const thread = th.data.thread;
  const ask = e.text.replace(/@[\p{L}\p{N}_-]+/gu, '').trim();
  await api.status('thinking', `reading “${(thread.quote || ask).slice(0, 60)}”`);
  await sleep(jitter(500, 1300));
  const doc = await api.doc(e.docId);
  const blocks = doc.data.blocks;

  // Anchored thread: act on that block.
  if (thread.blockId) {
    const block = blocks.find((b) => b.id === thread.blockId);
    if (!block) return reply(api, e, 'That block is gone now, so there is nothing for me to change here.', seen);
    return actOnBlock(api, agent, role, e, block, seen, ask, log);
  }

  // Doc-level ask: review the whole doc in my specialty.
  return reviewDoc(api, agent, role, e, blocks, seen, ask);
}

async function actOnBlock(api, agent, role, e, block, seen, ask) {
  const wantsWrite = /\b(write|draft|add|expand|rewrite|shorten|tighten|fix|edit|punch)/i.test(ask);
  if (role === 'editor' || (wantsWrite && role !== 'fact' && role !== 'skeptic')) {
    let next = tighten(block.text);
    if (/shorten|shorter|cut/i.test(ask)) next = sentences(next).slice(0, Math.max(1, sentences(next).length - 1)).join(' ');
    if (next === block.text) return reply(api, e, 'I read this twice and it is already tight. I would leave it.', seen);
    const lease = await api.lease(e.docId, [block.id], 30_000);
    if (!lease.ok) return reply(api, e, `I can't touch this block right now: ${lease.text}`, seen);
    await api.status('working', `drafting an edit to ${block.id}`);
    await sleep(jitter(600, 1500));
    const p = await api.propose(e.docId, { kind: 'edit', block_id: block.id, base_text: block.text, text: next, rationale: 'Cut filler words; same meaning, fewer words.', thread_id: e.threadId });
    await api.release(e.docId);
    if (!p.ok) return reply(api, e, `My edit didn't go through: ${p.text}`, seen);
    const saved = block.text.split(/\s+/).length - next.split(/\s+/).length;
    return reply(api, e, `Proposed a tighter version (${saved} fewer words, nothing of substance removed). ${p.state === 'committed' ? 'It is applied.' : 'It is in Changes for review.'}`, seen);
  }
  if (role === 'fact') {
    const claims = sentences(block.text).filter((s) => CLAIM.test(s));
    if (!claims.length) return reply(api, e, 'No checkable claims here: no numbers, studies or sources cited.', seen);
    return reply(
      api,
      e,
      claims.map((c) => `• “${c}” — what is the source? I can't verify this as written.`).join('\n') + '\nUntil there is a source, I would soften it to a qualitative statement.',
      seen,
    );
  }
  if (role === 'skeptic') {
    const abs = sentences(block.text).filter((s) => ABSOLUTE.test(s));
    const target = (abs[0] || sentences(block.text)[0] || block.text).replace(/[.!?]$/, '');
    const word = (target.match(ABSOLUTE) || [])[0];
    return reply(
      api,
      e,
      word
        ? `“${word}” is doing a lot of work in “${target}”. What would we do if it turned out false? Name the risk and the fallback.`
        : `Strongest counter-argument: “${target}” assumes the reader already agrees with us. What evidence would change our mind?`,
      seen,
    );
  }
  // scribe
  const msgs = (await api.thread(e.docId, e.threadId)).data.thread.messages;
  const people = [...new Set(msgs.map((m) => m.author.name))];
  return reply(api, e, `Summary so far: ${msgs.length} messages from ${people.join(', ')}. Ask: “${ask || 'n/a'}”. Nothing is decided yet.`, seen);
}

async function reviewDoc(api, agent, role, e, blocks, seen, ask) {
  const prose = blocks.filter((b) => ['p', 'li', 'quote'].includes(b.type) && b.text.trim());
  if (role === 'editor') {
    const targets = prose.filter((b) => tighten(b.text) !== b.text).slice(0, 3);
    if (!targets.length) return reply(api, e, 'Read the whole doc; nothing I would cut.', seen);
    const done = [];
    const skipped = [];
    for (const b of targets) {
      const lease = await api.lease(e.docId, [b.id], 30_000);
      if (!lease.ok) {
        skipped.push(b.id);
        continue;
      }
      await api.status('working', `tightening ${b.id}`);
      await sleep(jitter(500, 1200));
      const p = await api.propose(e.docId, { kind: 'edit', block_id: b.id, base_text: b.text, text: tighten(b.text), rationale: 'Cut filler words.', thread_id: e.threadId });
      if (p.ok) done.push(b.id);
      else skipped.push(b.id);
    }
    await api.release(e.docId);
    return reply(api, e, `Proposed ${done.length} edit${done.length === 1 ? '' : 's'} cutting filler (${done.join(', ') || 'none'}).${skipped.length ? ` Skipped ${skipped.join(', ')}: another agent holds it or it changed.` : ''}`, seen);
  }
  if (role === 'fact') {
    let n = 0;
    for (const b of prose) {
      for (const s of sentences(b.text).filter((x) => CLAIM.test(x))) {
        await api.status('working', `checking “${s.slice(0, 50)}”`);
        await sleep(jitter(300, 800));
        await api.comment(e.docId, { block_id: b.id, quote: s.replace(/[.!?]$/, ''), text: `Source needed. I can't find support for this claim; link it or soften it.`, hop: e.hop });
        n++;
      }
    }
    return reply(api, e, n ? `Flagged ${n} claim${n === 1 ? '' : 's'} that need sources. Each has its own comment.` : 'Every claim here is qualitative; nothing to source.', seen);
  }
  if (role === 'skeptic') {
    const hits = [];
    for (const b of prose) for (const s of sentences(b.text)) if (ABSOLUTE.test(s)) hits.push([b, s]);
    for (const [b, s] of hits.slice(0, 3)) {
      await api.status('working', 'pressure-testing the plan');
      await sleep(jitter(400, 900));
      const word = s.match(ABSOLUTE)[0];
      await api.comment(e.docId, { block_id: b.id, quote: s.replace(/[.!?]$/, ''), text: `“${word}” is an absolute. What's the evidence, and what's our plan if it's wrong?`, hop: e.hop });
    }
    const numeric = prose.find((b) => CLAIM.test(b.text));
    let extra = '';
    if (numeric && e.hop < 2) extra = ` @Fact-Checker can you verify the numbers in ${numeric.id}? The plan leans on them.`;
    return reply(api, e, `Left ${Math.min(hits.length, 3)} challenge${hits.length === 1 ? '' : 's'} on absolute claims.${extra}`, seen);
  }
  // scribe: draft a TL;DR at the top
  const firsts = prose.slice(0, 4).map((b) => sentences(b.text)[0]).filter(Boolean);
  const tldr = firsts.map((s) => tighten(s).replace(/[.!?]$/, '')).join('; ') + '.';
  const p = await api.propose(e.docId, {
    kind: 'insert',
    after_block_id: null,
    blocks: [
      { type: 'h2', text: 'TL;DR' },
      { type: 'p', text: tldr },
    ],
    rationale: 'A two-line summary so readers get the point before the details.',
    thread_id: e.threadId,
  });
  return reply(api, e, p.ok ? `Drafted a TL;DR for the top of the doc. ${p.state === 'committed' ? 'Applied.' : 'Review it in Changes.'}` : `Couldn't add a TL;DR: ${p.text}`, seen);
}
