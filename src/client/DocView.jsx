import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquarePlus, MessageSquare } from 'lucide-react';
import { BlockEditor, LOCAL } from './BlockEditor.jsx';
import { useY, useDocEvent } from './hooks.js';
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

export function DocView({ client, doc, space, me, activeThreadId, onOpenThread, onStartComment, toast }) {
  const [expanded, setExpanded] = useState({});
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
      marks.push({ start: s, end: e, tid, cls: 'thread' + (tid === activeThreadId ? ' active' : '') + (by?.kind === 'agent' ? ' by-agent' : '') });
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

  const items = [];
  const insertsAt = (afterId) => pending.filter((p) => p.kind === 'insert' && (p.afterBlockId || null) === afterId);
  for (const p of insertsAt(null)) items.push(<ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />);
  blocks.forEach((b) => {
    const id = b.get('id');
    const type = b.get('type');
    const lease = leases.find((l) => l.blockId === id);
    const blockProps = pending.filter((p) => p.blockId === id && p.kind !== 'insert');
    const activeHere = threads.some((t) => t.get('id') === activeThreadId && t.get('blockId') === id);
    // Clicking into a discussed passage opens its thread (the newest one if several overlap).
    const threadAt = (pos) =>
      threads
        .filter((t) => t.get('blockId') === id && !t.get('resolved'))
        .filter((t) => {
          const s = resolveRel(ydoc, t.get('start'));
          const e = resolveRel(ydoc, t.get('end'));
          return s !== null && e !== null && s <= pos && pos <= e && e > s;
        })
        .sort((a, b) => b.get('createdAt') - a.get('createdAt'))[0];
    items.push(
      <div
        key={id}
        className={`block t-${type}${lease ? ' leased' : ''}${flash[id] ? ' flash' : ''}${activeHere ? ' has-active' : ''}`}
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
          onCaretClick={(pos) => {
            const t = threadAt(pos);
            if (t && t.get('id') !== activeThreadId) onOpenThread(t.get('id'), id);
          }}
        />
        {lease && (
          <span className="lease-chip" title="This agent is working on the block; other agents stay off it">
            <i className="pulse" /> {lease.name} is editing
          </span>
        )}
        <div className="block-side">
          <button className="icon-btn" title="Comment on this block (⌘⌥M)" aria-label="Comment on this block" onClick={() => startComment(b, 0, 0)}>
            <MessageSquarePlus className="i" />
          </button>
        </div>
        {blockProps.slice(0, expanded[id] ? blockProps.length : 1).map((p) => (
          <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />
        ))}
        {blockProps.length > 1 && (
          <button className="link more-props" onClick={() => setExpanded((x) => ({ ...x, [id]: !x[id] }))}>
            {expanded[id] ? 'Show fewer suggestions' : `${blockProps.length - 1} more suggestion${blockProps.length > 2 ? 's' : ''} for this paragraph`}
          </button>
        )}
      </div>,
    );
    for (const p of insertsAt(id)) items.push(<ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} inline toast={toast} />);
  });

  return (
    <div className="doc-col">
      <input
        className="doc-title"
        value={title}
        placeholder="Untitled"
        aria-label="Doc title"
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
            <MessageSquare className="i" style={{ width: 14, height: 14 }} /> Comment
          </button>
          {space.agents.length > 0 && <span className="sep" />}
          {space.agents.slice(0, 4).map((a) => (
            <button
              key={a.id}
              className="ask"
              title={`Ask @${a.name} about this`}
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
