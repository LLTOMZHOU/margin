import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BlockEditor, LOCAL } from './BlockEditor.jsx';
import { useY, useDocEvent, initials } from './hooks.js';
import { ProposalCard } from './Proposals.jsx';
import { blocksOf, threadsOf, proposalsOf, logOf, metaOf, makeBlock, findBlock, encodeRel, resolveRel, BLOCK_TYPES } from '../shared/schema.js';

const TYPE_LABEL = { h1: 'H1', h2: 'H2', h3: 'H3', p: '¶', li: '•', quote: '❝', code: '{}' };
const SHORTCUTS = [
  [/^###\s/, 'h3'],
  [/^##\s/, 'h2'],
  [/^#\s/, 'h1'],
  [/^[-*]\s/, 'li'],
  [/^>\s/, 'quote'],
  [/^```/, 'code'],
];

export function DocView({ client, doc, space, me, activeThreadId, setActiveThreadId, onStartComment, toast }) {
  const ydoc = doc.ydoc;
  const blocks = blocksOf(ydoc);
  useY(blocks);
  useY(threadsOf(ydoc));
  useY(proposalsOf(ydoc));
  useY(metaOf(ydoc), false);
  useDocEvent(doc, 'presence');
  useDocEvent(doc, 'leases');
  useDocEvent(doc, 'synced');

  const editors = useRef(new Map());
  const [focusReq, setFocusReq] = useState(null);
  const [sel, setSel] = useState(null); // { blockId, start, end }
  const [focused, setFocused] = useState(null);
  const selRef = useRef(null);
  const [toolbar, setToolbar] = useState(null);
  const [flash, setFlash] = useState({});

  // Focus a block after structural edits re-render.
  useEffect(() => {
    if (!focusReq) return;
    const ed = editors.current.get(focusReq.blockId);
    if (ed) {
      ed.focus(focusReq.pos);
      setFocusReq(null);
    }
  });

  // Flash blocks when an agent's proposal lands.
  const log = logOf(ydoc);
  useEffect(() => {
    let seen = log.length;
    const f = () => {
      const fresh = log.toArray().slice(seen);
      seen = log.length;
      for (const e of fresh) {
        if (e.kind !== 'proposal' || !e.summary.startsWith('committed')) continue;
        const p = proposalsOf(ydoc).get(e.proposalId);
        const id = p?.blockId || p?.afterBlockId;
        if (!id) continue;
        setFlash((x) => ({ ...x, [id]: p.author.color }));
        setTimeout(() => setFlash((x) => ({ ...x, [id]: undefined })), 1600);
      }
    };
    log.observe(f);
    return () => log.unobserve(f);
  }, [log, ydoc]);

  // Presence: tell others where my caret is (as CRDT-relative positions).
  const lastPresence = useRef(0);
  const sendPresence = (blockId, start, end) => {
    const now = Date.now();
    if (now - lastPresence.current < 40) return;
    lastPresence.current = now;
    const f = blockId && findBlock(ydoc, blockId);
    if (!f) return doc.setPresence({ blockId: null });
    const yt = f.block.get('text');
    doc.setPresence({ blockId, anchor: encodeRel(yt, start), head: encodeRel(yt, end) });
  };

  useLayoutEffect(() => {
    const measure = () => {
      if (!sel || sel.start === sel.end || focused !== sel.blockId || !selRef.current) return setToolbar(null);
      const r = selRef.current.getBoundingClientRect();
      setToolbar({ top: r.top - 40, left: Math.max(12, r.left) });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [sel, focused]);

  const presence = doc.presence || [];
  const leases = (doc.leases || []).filter((l) => l.expires > Date.now());
  const threads = [...threadsOf(ydoc).values()];
  const proposals = [...proposalsOf(ydoc).values()];
  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'held');
  const title = metaOf(ydoc).get('title') || '';
  const policy = metaOf(ydoc).get('policy') || 'one';
  const humansHere = presence.filter((p) => p.kind === 'human');
  const agentsHere = presence.filter((p) => p.kind === 'agent');

  const split = (b, idx, el) => {
    const i = findBlock(ydoc, b.get('id')).index;
    const yt = b.get('text');
    const tail = yt.toString().slice(el.selectionEnd);
    const type = b.get('type');
    const nb = makeBlock(type === 'li' ? 'li' : type === 'code' ? 'code' : 'p', tail);
    ydoc.transact(() => {
      yt.delete(el.selectionStart, yt.length - el.selectionStart);
      blocks.insert(i + 1, [nb]);
    }, LOCAL);
    setFocusReq({ blockId: nb.get('id'), pos: 0 });
  };

  const onKeyDown = (b) => (e, el) => {
    const i = findBlock(ydoc, b.get('id'))?.index;
    if (i === undefined) return;
    const type = b.get('type');
    if (e.key === 'Enter' && !e.shiftKey && type !== 'code') {
      e.preventDefault();
      if (type === 'li' && !el.value) {
        ydoc.transact(() => b.set('type', 'p'), LOCAL);
        return;
      }
      split(b, i, el);
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (type !== 'p') {
        e.preventDefault();
        ydoc.transact(() => b.set('type', 'p'), LOCAL);
      } else if (i > 0) {
        e.preventDefault();
        const prev = blocks.get(i - 1);
        const pt = prev.get('text');
        const at = pt.length;
        ydoc.transact(() => {
          pt.insert(at, b.get('text').toString());
          blocks.delete(i, 1);
        }, LOCAL);
        setFocusReq({ blockId: prev.get('id'), pos: at });
      }
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && i > 0) {
      e.preventDefault();
      editors.current.get(blocks.get(i - 1).get('id'))?.focus('end');
    } else if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length && i < blocks.length - 1) {
      e.preventDefault();
      editors.current.get(blocks.get(i + 1).get('id'))?.focus(0);
    } else if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      startComment(b, el.selectionStart, el.selectionEnd);
    }
  };

  const typeShortcut = (b) => (next) => {
    if (b.get('type') !== 'p') return false;
    for (const [re, type] of SHORTCUTS) {
      const m = next.match(re);
      if (m) {
        const yt = b.get('text');
        ydoc.transact(() => {
          b.set('type', type);
          yt.delete(0, yt.length);
          yt.insert(0, next.slice(m[0].length));
        }, LOCAL);
        setFocusReq({ blockId: b.get('id'), pos: 0 });
        return true;
      }
    }
    return false;
  };

  const startComment = (b, start, end) => {
    const text = b.get('text').toString();
    if (start === end) {
      start = 0;
      end = text.length;
    }
    onStartComment({ blockId: b.get('id'), start, end, quote: text.slice(start, end) });
  };

  const blockMarks = (b) => {
    const id = b.get('id');
    const marks = [];
    for (const t of threads) {
      if (t.get('blockId') !== id || t.get('resolved')) continue;
      const s = resolveRel(ydoc, t.get('start'));
      const e = resolveRel(ydoc, t.get('end'));
      if (s === null || e === null || e <= s) continue;
      const tid = t.get('id');
      const by = t.get('createdBy');
      marks.push({ start: s, end: e, cls: 'thread' + (tid === activeThreadId ? ' active' : '') + (by?.kind === 'agent' ? ' by-agent' : ''), color: by?.color || '#e8b100' });
    }
    for (const p of presence) {
      if (p.kind !== 'human' || p.id === me.id || p.blockId !== id) continue;
      const a = resolveRel(ydoc, p.anchor);
      const h = resolveRel(ydoc, p.head);
      if (a !== null && h !== null && a !== h) marks.push({ start: Math.min(a, h), end: Math.max(a, h), cls: 'peer-sel', color: p.color });
    }
    if (sel && sel.blockId === id && sel.start !== sel.end) marks.push({ start: sel.start, end: sel.end, cls: 'self-sel' + (focused === id ? ' live' : ''), color: me.color });
    return marks;
  };

  const blockCarets = (b) => {
    const id = b.get('id');
    return presence
      .filter((p) => p.kind === 'human' && p.id !== me.id && p.blockId === id)
      .map((p) => ({ index: resolveRel(ydoc, p.head) ?? 0, color: p.color, name: p.name, key: p.connId }))
      .filter((c) => c.index !== null);
  };

  const threadCount = (id) => threads.filter((t) => t.get('blockId') === id && !t.get('resolved')).length;

  const items = [];
  const insertsAt = (afterId) => pending.filter((p) => p.kind === 'insert' && (p.afterBlockId || null) === afterId);
  for (const p of insertsAt(null)) items.push(<ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />);
  blocks.forEach((b) => {
    const id = b.get('id');
    const type = b.get('type');
    const lease = leases.find((l) => l.blockId === id);
    const blockProps = pending.filter((p) => p.blockId === id && p.kind !== 'insert');
    const n = threadCount(id);
    items.push(
      <div
        key={id}
        className={`block t-${type}${lease ? ' leased' : ''}${flash[id] ? ' flash' : ''}`}
        style={{ '--lease': lease?.color, '--flash': flash[id] }}
        data-block={id}
      >
        <div className="gutter">
          <select
            className="type-pick"
            value={type}
            title="Block type"
            onChange={(e) => ydoc.transact(() => b.set('type', e.target.value), LOCAL)}
          >
            {BLOCK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <BlockEditor
          ref={(r) => (r ? editors.current.set(id, r) : editors.current.delete(id))}
          block={b}
          ydoc={ydoc}
          marks={blockMarks(b)}
          carets={blockCarets(b)}
          selRef={sel?.blockId === id ? selRef : undefined}
          placeholder={blocks.length === 1 ? 'Start writing… (# for heading, - for list)' : ''}
          onKeyDown={onKeyDown(b)}
          onTypeShortcut={typeShortcut(b)}
          onSelection={(s, e) => {
            setSel({ blockId: id, start: s, end: e });
            sendPresence(id, s, e);
          }}
          onFocusChange={(f) => setFocused((cur) => (f ? id : cur === id ? null : cur))}
        />
        <div className="block-side">
          {lease && (
            <span className="lease-chip" style={{ '--c': lease.color }} title="This agent holds a lease on the block">
              <i className="pulse" /> {lease.name}
            </span>
          )}
          {n > 0 && (
            <button
              className="thread-count"
              onClick={() => {
                const t = threads.find((t) => t.get('blockId') === id && !t.get('resolved'));
                if (t) setActiveThreadId(t.get('id'));
              }}
            >
              💬 {n}
            </button>
          )}
          <button className="comment-btn" title="Comment on this block (⌘⌥M)" onClick={() => startComment(b, 0, 0)}>
            +💬
          </button>
        </div>
        {blockProps.map((p) => (
          <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />
        ))}
      </div>,
    );
    for (const p of insertsAt(id)) items.push(<ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />);
  });

  return (
    <div className="doc-wrap">
      <header className="doc-header">
          <div className="presence">
            {humansHere.map((p) => (
              <span key={'h' + p.connId} className="avatar human" style={{ '--c': p.color }} title={`${p.name}${p.id === me.id ? ' (you)' : ''}`}>
                {initials(p.name)}
              </span>
            ))}
            {agentsHere.map((p) => (
              <span key={'a' + p.id} className={`avatar agent st-${p.status}`} style={{ '--c': p.color }} title={`${p.name} — ${p.status}${p.detail ? `: ${p.detail}` : ''}`}>
                {initials(p.name)}
              </span>
            ))}
          </div>
          <label className="policy" title="Who has to approve an agent's change before it lands">
            Agent edits:
            <select value={policy} onChange={(e) => client.rpc('doc.policy', { docId: doc.docId, policy: e.target.value }).catch((er) => toast(er.message))}>
              {Object.entries(space.policies).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
      </header>
        <input
          className="doc-title"
          value={title}
          placeholder="Untitled"
          onChange={(e) => ydoc.transact(() => metaOf(ydoc).set('title', e.target.value), LOCAL)}
        />
      <div className="doc">{doc.synced ? items : <div className="loading">Syncing…</div>}</div>
      {toolbar && (
        <div className="sel-toolbar" style={{ top: toolbar.top, left: toolbar.left }} onMouseDown={(e) => e.preventDefault()}>
          <button
            onClick={() => {
              const f = findBlock(ydoc, sel.blockId);
              if (f) startComment(f.block, sel.start, sel.end);
            }}
          >
            💬 Comment
          </button>
          {space.agents.slice(0, 4).map((a) => (
            <button
              key={a.id}
              className="ask-chip"
              style={{ '--c': a.color }}
              onClick={() => {
                const f = findBlock(ydoc, sel.blockId);
                if (f) onStartComment({ blockId: sel.blockId, start: sel.start, end: sel.end, quote: f.block.get('text').toString().slice(sel.start, sel.end), mention: a.name });
              }}
            >
              @{a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
