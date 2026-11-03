// Document model shared by the hub, the browser, and tests.
//
// A doc is a Yjs document:
//   blocks    Y.Array<Y.Map{ id, type, text: Y.Text }>   edited directly by humans (CRDT)
//   threads   Y.Map<id, Y.Map{ ...meta, messages: Y.Array }>  written by the hub only
//   proposals Y.Map<id, plain object>                     written by the hub only
//   log       Y.Array<plain object>                       append-only, hub only
//   meta      Y.Map{ title, policy }
import * as Y from 'yjs';

export const BLOCK_TYPES = ['h1', 'h2', 'h3', 'p', 'li', 'quote', 'code'];
export const POLICIES = {
  auto: 'Agent edits apply immediately',
  one: 'Any one human approves',
  majority: 'Majority of online humans approve',
};

export function uid(prefix = '') {
  const a = new Uint8Array(6);
  globalThis.crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

export const blocksOf = (ydoc) => ydoc.getArray('blocks');
export const threadsOf = (ydoc) => ydoc.getMap('threads');
export const proposalsOf = (ydoc) => ydoc.getMap('proposals');
export const logOf = (ydoc) => ydoc.getArray('log');
export const metaOf = (ydoc) => ydoc.getMap('meta');

export function makeBlock(type, text = '', id = uid('b')) {
  const m = new Y.Map();
  m.set('id', id);
  m.set('type', type);
  m.set('text', new Y.Text(text));
  return m;
}

export function findBlock(ydoc, blockId) {
  const arr = blocksOf(ydoc);
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get('id') === blockId) return { index: i, block: arr.get(i) };
  }
  return null;
}

export function blockText(block) {
  return block.get('text').toString();
}

export function snapshot(ydoc) {
  return blocksOf(ydoc).toArray().map((b) => ({ id: b.get('id'), type: b.get('type'), text: blockText(b) }));
}

export function seedDoc(ydoc, { title, blocks, policy = 'one' }) {
  ydoc.transact(() => {
    metaOf(ydoc).set('title', title);
    metaOf(ydoc).set('policy', policy);
    blocksOf(ydoc).push(blocks.map(([type, text]) => makeBlock(type, text)));
  }, 'seed');
}

// ---------- relative positions (anchors that survive concurrent edits) ----------

const toB64 = (u8) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) =>
  typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encodeRel(ytext, index, assoc = 0) {
  return toB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, index, assoc)));
}

export function resolveRel(ydoc, b64) {
  if (!b64) return null;
  const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromB64(b64)), ydoc);
  return abs ? abs.index : null;
}

export { toB64, fromB64 };

// ---------- text diff / 3-way merge ----------

// Tokenize into words, whitespace runs, and punctuation so hunks line up with how people edit.
function tokenize(s) {
  return s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) || [];
}

// Hunks that turn `a` into `b`: [{ start, end, insert }] in `a` character offsets.
export function diffHunks(a, b) {
  if (a === b) return [];
  const A = tokenize(a);
  const B = tokenize(b);
  // trim common prefix/suffix tokens, then LCS on the middle
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a2 = A.slice(p, A.length - s);
  const b2 = B.slice(p, B.length - s);
  const n = a2.length;
  const m = b2.length;
  let ops;
  if (n * m > 4_000_000) {
    ops = [{ del: a2, ins: b2 }];
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    ops = [];
    let i = 0;
    let j = 0;
    let cur = null;
    const flush = () => {
      if (cur) ops.push(cur);
      cur = null;
    };
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        flush();
        ops.push({ eq: a2[i] });
        i++;
        j++;
      } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
        cur = cur || { del: [], ins: [] };
        cur.ins.push(b2[j++]);
      } else {
        cur = cur || { del: [], ins: [] };
        cur.del.push(a2[i++]);
      }
    }
    flush();
  }
  const hunks = [];
  let off = A.slice(0, p).join('').length;
  for (const op of ops) {
    if (op.eq !== undefined) off += op.eq.length;
    else {
      const delLen = op.del.join('').length;
      hunks.push({ start: off, end: off + delLen, insert: op.ins.join('') });
      off += delLen;
    }
  }
  return hunks;
}

function overlaps(h, k) {
  if (h.start === h.end && k.start === k.end) return h.start === k.start; // two inserts at one point
  if (h.start === h.end) return h.start > k.start && h.start < k.end;
  if (k.start === k.end) return k.start > h.start && k.start < h.end;
  return h.start < k.end && k.start < h.end;
}

// Merge two independent edits of `base`. Returns { ok: true, text } or
// { ok: false, conflicts: [{ base, ours, theirs }] } when they touch the same words.
export function merge3(base, ours, theirs) {
  if (ours === theirs) return { ok: true, text: ours, clean: true };
  if (ours === base) return { ok: true, text: theirs, clean: true };
  if (theirs === base) return { ok: true, text: ours, clean: true };
  const H = diffHunks(base, ours).map((h) => ({ ...h, side: 'ours' }));
  const K = diffHunks(base, theirs).map((h) => ({ ...h, side: 'theirs' }));
  const conflicts = [];
  for (const h of H)
    for (const k of K)
      if (overlaps(h, k) && !(h.start === k.start && h.end === k.end && h.insert === k.insert))
        conflicts.push({ base: base.slice(Math.min(h.start, k.start), Math.max(h.end, k.end)), ours: h.insert, theirs: k.insert });
  if (conflicts.length) return { ok: false, conflicts };
  const all = [...H, ...K.filter((k) => !H.some((h) => h.start === k.start && h.end === k.end && h.insert === k.insert))];
  all.sort((x, y) => x.start - y.start || (x.side === 'theirs' ? -1 : 1));
  let out = '';
  let pos = 0;
  for (const h of all) {
    out += base.slice(pos, h.start) + h.insert;
    pos = h.end;
  }
  return { ok: true, text: out + base.slice(pos), clean: false };
}

// Rewrite a Y.Text to `next` with minimal operations, so other people's cursors stay put.
export function applyTextMinimal(ytext, next) {
  const cur = ytext.toString();
  if (cur === next) return;
  const hunks = diffHunks(cur, next);
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i];
    if (h.end > h.start) ytext.delete(h.start, h.end - h.start);
    if (h.insert) ytext.insert(h.start, h.insert);
  }
}

// Plain-text rendering agents read. Block ids let them target edits precisely.
export function renderForAgent(ydoc) {
  const title = metaOf(ydoc).get('title') || 'Untitled';
  const lines = [`# ${title}`, ''];
  for (const b of snapshot(ydoc)) {
    lines.push(`[${b.id}] (${b.type}) ${b.text}`);
  }
  return lines.join('\n');
}
