import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { merge3, diffHunks, applyTextMinimal } from '../src/shared/schema.js';

const WORDS = 'the team will ship a shared notebook for research labs in march with comments and agents that propose edits'.split(' ');
const rnd = (n) => Math.floor(Math.random() * n);
const sentence = (n) => Array.from({ length: n }, () => WORDS[rnd(WORDS.length)]).join(' ');

test('diffHunks reproduces the target', () => {
  for (let i = 0; i < 500; i++) {
    const a = sentence(rnd(20));
    const b = sentence(rnd(20));
    let out = '';
    let pos = 0;
    for (const h of diffHunks(a, b)) {
      out += a.slice(pos, h.start) + h.insert;
      pos = h.end;
    }
    assert.equal(out + a.slice(pos), b);
  }
});

test('edits to different words merge and keep both', () => {
  const base = 'We will launch in March. The pricing is very simple and really clear.';
  const agent = 'We will launch in March. The pricing is simple and clear.';
  const human = 'We will launch in April. The pricing is very simple and really clear.';
  assert.deepEqual(merge3(base, agent, human), { ok: true, text: 'We will launch in April. The pricing is simple and clear.', clean: false });
});

test('edits to the same words conflict instead of silently picking one', () => {
  const r = merge3('ship in March', 'ship in May', 'ship in April');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
});

test('property: disjoint edits on random text always merge to both edits applied', () => {
  for (let i = 0; i < 400; i++) {
    const words = sentence(12 + rnd(10)).split(' ');
    const base = words.join(' ');
    // pick two disjoint word indices, separated by at least one untouched word
    const a = rnd(words.length - 2);
    const b = a + 2 + rnd(words.length - a - 2);
    const ours = words.map((w, k) => (k === a ? 'OURS' : w)).join(' ');
    const theirs = words.map((w, k) => (k === b ? 'THEIRS' : w)).join(' ');
    const want = words.map((w, k) => (k === a ? 'OURS' : k === b ? 'THEIRS' : w)).join(' ');
    const r = merge3(base, ours, theirs);
    assert.ok(r.ok, `should merge: ${base}`);
    assert.equal(r.text, want);
  }
});

test('applyTextMinimal keeps other people’s positions outside the changed words', () => {
  const doc = new Y.Doc();
  const t = doc.getText('t');
  t.insert(0, 'Research teams are basically drowning in notes.');
  const rel = Y.createRelativePositionFromTypeIndex(t, t.toString().indexOf('notes'));
  applyTextMinimal(t, 'Research teams are drowning in notes.');
  assert.equal(t.toString(), 'Research teams are drowning in notes.');
  assert.equal(Y.createAbsolutePositionFromRelativePosition(rel, doc).index, t.toString().indexOf('notes'));
});
