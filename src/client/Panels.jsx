import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, X, FileText, CheckCheck, RotateCcw } from 'lucide-react';
import { useY, useNow, ago, initials } from './hooks.js';
import { ProposalCard } from './Proposals.jsx';
import { threadsOf, proposalsOf, logOf, blocksOf, findBlock, encodeRel, resolveRel } from '../shared/schema.js';

const GAP = 8; // between stacked cards in the margin
const TOP = 46; // below the margin header

function MessageText({ text, agents }) {
  const names = new Set(agents.map((a) => a.name.toLowerCase()));
  const parts = text.split(/(@[\p{L}\p{N}_-]+)/u);
  return (
    <div className="msg-text">
      {parts.map((p, i) =>
        p.startsWith('@') && (names.has(p.slice(1).toLowerCase()) || ['@agents', '@all'].includes(p.toLowerCase())) ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

function Composer({ agents, onSend, placeholder, autoFocus, initial = '', sendLabel = 'Reply' }) {
  const [text, setText] = useState(initial);
  const ref = useRef();
  useEffect(() => {
    setText(initial);
    if (autoFocus)
      setTimeout(() => {
        const el = ref.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
  }, [initial, autoFocus]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    if ((await onSend(t)) !== false) setText('');
  };
  const insert = (name) => {
    setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + '@' + name + ' ');
    ref.current?.focus();
  };
  return (
    <div className="composer" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-row">
        <div className="chips">
          {agents.slice(0, 2).map((a) => (
            <button key={a.id} className="chip" onClick={() => insert(a.name)} title={a.description}>
              @{a.name}
            </button>
          ))}
        </div>
        <button className="btn sm primary" onClick={send} disabled={!text.trim()}>
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

function Typing({ thread, agents }) {
  const msgs = thread.messages;
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const asked = (a) => new RegExp('@(' + a.name + '|agents|all)\\b', 'i').test(last.text);
  const involved = new Set(msgs.filter((m) => m.author.kind === 'agent').map((m) => m.author.id));
  for (const a of agents) if (asked(a)) involved.add(a.id);
  const busy = agents.filter((a) => involved.has(a.id) && ['thinking', 'working'].includes(a.status) && last.author.id !== a.id);
  const queued = agents.filter((a) => involved.has(a.id) && !busy.includes(a) && last.author.kind === 'human' && asked(a) && !a.online);
  return (
    <>
      {busy.map((a) => (
        <div key={a.id} className="typing">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          {a.name} is {a.status}
          {a.detail ? ` · ${a.detail}` : ''}
        </div>
      ))}
      {queued.map((a) => (
        <div key={a.id} className="typing off">
          {a.name} is offline. It will pick this up when its computer reconnects.
        </div>
      ))}
    </>
  );
}

function wordsState(ydoc, t, f) {
  const quote = t.get('quote');
  if (!t.get('blockId') || !f || !quote) return {};
  const s = resolveRel(ydoc, t.get('start'));
  const e = resolveRel(ydoc, t.get('end'));
  const now = s !== null && e !== null && e > s ? f.block.get('text').toString().slice(s, e) : '';
  if (!now.trim()) return { wordsGone: true };
  return now !== quote ? { wordsChanged: true } : {};
}

export function threadView(ydoc, t) {
  const blockId = t.get('blockId');
  const f = blockId && findBlock(ydoc, blockId);
  return {
    id: t.get('id'),
    blockId,
    blockIndex: f ? f.index : blockId ? 1e9 : -1,
    start: resolveRel(ydoc, t.get('start')) ?? 0,
    quote: t.get('quote'),
    // Have the words this thread is about been edited since it started?
    ...wordsState(ydoc, t, f),
    resolved: t.get('resolved'),
    createdBy: t.get('createdBy'),
    createdAt: t.get('createdAt'),
    messages: t.get('messages').toArray(),
    orphan: blockId && !f,
  };
}

function Msg({ m, agents, now, compact, replies = 0 }) {
  return (
    <div className={`msg ${m.author.kind}`}>
      <span className={`avatar ${m.author.kind} sm`}>{initials(m.author.name)}</span>
      <div className="msg-body">
        <div className="msg-meta">
          <b>{m.author.name}</b>
          {m.author.kind === 'agent' && <span className="who-tag">agent</span>}
          <span className="muted">{ago(m.ts, now)}</span>
          {compact && replies > 0 && <span className="muted replies">{replies === 1 ? '1 reply' : `${replies} replies`}</span>}
        </div>
        <MessageText text={m.text} agents={agents} />
      </div>
    </div>
  );
}

function ThreadCard({ t, active, onOpen, client, docId, agents, toast, onFocusBlock, now, style, cardRef, showQuote, narrow }) {
  const send = (text) =>
    client.rpc('thread.post', { docId, threadId: t.id, text }).catch((e) => {
      toast(e.message);
      return false;
    });
  const [first, ...replies] = t.messages;
  return (
    <div
      ref={cardRef}
      data-thread={t.id}
      className={`mcard ${active ? 'active' : ''} ${t.blockId ? '' : 'doc-level'}`}
      style={style}
      onClick={() => {
        if (active) return;
        onOpen(t.id);
        if (t.blockId) onFocusBlock(t.blockId, { quiet: !narrow, top: narrow });
      }}
    >
      {!t.blockId && (
        <div className="scope">
          <FileText className="i" style={{ width: 13, height: 13 }} /> On the whole doc
        </div>
      )}
      {t.orphan || t.wordsGone || t.wordsChanged ? (
        <div className="scope gone">
          {t.orphan ? 'The paragraph was deleted' : t.wordsGone ? 'These words were edited away' : 'The words have changed since'}
          {t.quote && <s className="quote-text">{t.quote}</s>}
        </div>
      ) : (
        t.blockId && (showQuote || active) && t.quote && <div className="quote-text">{t.quote}</div>
      )}
      {active ? t.messages.map((m) => <Msg key={m.id} m={m} agents={agents} now={now} />) : first && <Msg m={first} agents={agents} now={now} compact replies={replies.length} />}
      <Typing thread={t} agents={agents} />
      {active ? (
        <div onClick={(e) => e.stopPropagation()}>
          <Composer agents={agents} onSend={send} placeholder="Reply, or @mention an agent" autoFocus />
          <div className="thread-actions">
            <button className="link" onClick={() => client.rpc('thread.resolve', { docId, threadId: t.id, resolved: !t.resolved }).then(() => onOpen(null), (e) => toast(e.message))}>
              {t.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Place each card beside its passage without overlaps. The open card sits exactly at its anchor;
// cards below it move down. Cards above it move up, and when there isn't room they fan into a deck
// (they are faded while a thread is open, and clicking one brings it forward).
function stack(items, activeId) {
  const out = new Map();
  if (!items.length) return out;
  const ai = items.findIndex((x) => x.id === activeId);
  if (ai < 0) {
    let floor = TOP;
    for (const x of items) {
      const top = Math.max(x.anchor, floor);
      out.set(x.id, top);
      floor = top + x.h + GAP;
    }
    return out;
  }
  const at = Math.max(TOP, items[ai].anchor);
  out.set(items[ai].id, at);
  for (let i = ai + 1; i < items.length; i++) out.set(items[i].id, Math.max(items[i].anchor, out.get(items[i - 1].id) + items[i - 1].h + GAP));
  for (let i = ai - 1; i >= 0; i--) out.set(items[i].id, Math.min(items[i].anchor, out.get(items[i + 1].id) - items[i].h - GAP));
  if (ai > 0 && out.get(items[0].id) < TOP) {
    const step = Math.max(0, (at - GAP - TOP - items[ai - 1].h) / Math.max(1, ai - 1));
    for (let i = 0; i < ai; i++) out.set(items[i].id, TOP + Math.min(i * step, i * (items[i].h + GAP)));
  }
  return out;
}

export function Margin({ client, doc, space, me, activeThreadId, setActiveThreadId, draft, setDraft, toast, onFocusBlock, pageRef, narrow, open, onClose }) {
  const ydoc = doc.ydoc;
  useY(threadsOf(ydoc));
  useY(blocksOf(ydoc));
  const now = useNow();
  const [showResolved, setShowResolved] = useState(false);
  const [layout, setLayout] = useState({});
  const [, relayout] = useState(0);
  const marginRef = useRef();
  const cards = useRef(new Map());
  const agents = space.agents;
  const all = [...threadsOf(ydoc).values()].map((t) => threadView(ydoc, t)).sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start);
  const resolvedCount = all.filter((t) => t.resolved).length;
  const shown = all.filter((t) => !!t.resolved === showResolved);
  // Several closed threads on one paragraph share one card, so the margin stays beside the text.
  const [openGroup, setOpenGroup] = useState(null);
  const grouped = [];
  const byBlock = new Map();
  for (const t of shown) {
    if (!t.blockId) grouped.push(t);
    else if (byBlock.has(t.blockId)) byBlock.get(t.blockId).push(t);
    else byBlock.set(t.blockId, [t]), grouped.push({ __block: t.blockId });
  }
  const threadsList = grouped.flatMap((g) => {
    if (!g.__block) return [g];
    const ts = byBlock.get(g.__block);
    const expanded = ts.length < 2 || openGroup === g.__block || ts.some((t) => t.id === activeThreadId);
    return expanded ? ts : [{ id: 'g:' + g.__block, group: ts, blockId: g.__block, blockIndex: ts[0].blockIndex, start: ts[0].start }];
  });
  const items = draft ? [{ id: '__draft', blockId: draft.blockId, draft: true }, ...threadsList].sort((a, b) => (a.blockIndex ?? idx(a)) - (b.blockIndex ?? idx(b))) : threadsList;
  function idx(x) {
    return x.blockId ? findBlock(ydoc, x.blockId)?.index ?? 1e9 : -1;
  }

  // Measure anchors and card heights after every render; only re-render when the layout changes.
  useLayoutEffect(() => {
    if (narrow || !marginRef.current || !pageRef.current) return;
    const base = marginRef.current.getBoundingClientRect().top;
    const measured = items.map((x) => {
      const anchorId = x.group ? x.group[0].id : x.id;
      const el = (x.id !== '__draft' && pageRef.current.querySelector(`[data-anchor~="${anchorId}"]`)) || (x.blockId && pageRef.current.querySelector(`[data-block="${x.blockId}"]`));
      const anchor = el ? el.getBoundingClientRect().top - base - 8 : TOP;
      return { id: x.id, anchor: x.blockId ? anchor : TOP, h: cards.current.get(x.id)?.offsetHeight || 80 };
    });
    const tops = stack(measured, draft ? '__draft' : activeThreadId);
    const next = {};
    for (const m of measured) {
      const tick = Math.round(m.anchor - tops.get(m.id) + 17);
      next[m.id] = { top: Math.round(tops.get(m.id)), tick, h: m.h, level: tick > 6 && tick < 40 };
    }
    if (JSON.stringify(next) !== JSON.stringify(layout)) setLayout(next);
  });

  // Re-layout when the page reflows or any card changes height (a reply box opening, a new message).
  const ro = useRef(null);
  useEffect(() => {
    if (narrow || !pageRef.current) return;
    ro.current = new ResizeObserver(() => relayout((n) => n + 1));
    ro.current.observe(pageRef.current);
    for (const el of cards.current.values()) ro.current.observe(el);
    return () => (ro.current.disconnect(), (ro.current = null));
  }, [narrow, pageRef]);
  const cardRef = (id) => (el) => {
    const old = cards.current.get(id);
    if (old && old !== el) ro.current?.unobserve(old);
    if (el) cards.current.set(id, el), ro.current?.observe(el);
    else cards.current.delete(id);
  };

  useEffect(() => {
    if (!activeThreadId || !narrow) return;
    cards.current.get(activeThreadId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeThreadId, narrow]);

  const createThread = async (text) => {
    try {
      let args = { docId: doc.docId, text };
      if (draft.blockId) {
        const f = findBlock(ydoc, draft.blockId);
        if (!f) throw new Error('That passage was deleted');
        const yt = f.block.get('text');
        args = { ...args, blockId: draft.blockId, start: encodeRel(yt, draft.start, 0), end: encodeRel(yt, draft.end, -1), quote: draft.quote };
      }
      const r = await client.rpc('thread.create', args);
      setDraft(null);
      setActiveThreadId(r.threadId);
    } catch (e) {
      toast(e.message);
      return false;
    }
  };

  const place = (id) => {
    if (narrow) return undefined;
    const l = layout[id];
    if (!l) return { top: TOP, opacity: 0 };
    const tickOk = l.tick > 6 && l.tick < l.h - 6;
    return { top: l.top, '--tick': `${Math.max(6, Math.min(l.h - 6, l.tick))}px`, '--tick-o': tickOk ? 1 : 0 };
  };
  const bottom = Math.max(0, ...Object.values(layout).map((l) => l.top + l.h));

  return (
    <aside ref={marginRef} className={`margin ${open ? 'open' : ''}`} style={narrow ? undefined : { minHeight: bottom + 40 }} aria-label="Threads">
      <div className="margin-head">
        {narrow ? (
          <button className="icon-btn" onClick={onClose} aria-label="Close threads">
            <X className="i" />
          </button>
        ) : (
          <span />
        )}
        <span style={{ display: 'flex', gap: 14 }}>
          {!draft && !showResolved && (
            <button className="link" onClick={() => setDraft({ blockId: null })}>
              <Plus className="i" style={{ width: 13, height: 13 }} /> Comment on the doc
            </button>
          )}
          {(resolvedCount > 0 || showResolved) && (
            <button className="link" onClick={() => setShowResolved((x) => !x)}>
              {showResolved ? (
                <>
                  <RotateCcw className="i" style={{ width: 13, height: 13 }} /> Open threads
                </>
              ) : (
                <>
                  <CheckCheck className="i" style={{ width: 13, height: 13 }} /> Resolved {resolvedCount}
                </>
              )}
            </button>
          )}
        </span>
      </div>
      {items.map((x) =>
        x.group ? (
          <div key={x.id} ref={cardRef(x.id)} className="mcard group" style={place(x.id)} onClick={() => setOpenGroup(x.blockId)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenGroup(x.blockId)}>
            {x.group[0].quote && <div className="quote-text">{x.group[0].quote}</div>}
            <div className="msg-meta">
              <span className="stack">
                {[...new Map(x.group.map((t) => [t.messages[0]?.author.id, t.messages[0]?.author])).values()].slice(0, 4).map((a) => a && (
                  <span key={a.id} className={`avatar ${a.kind} xs`}>{initials(a.name)}</span>
                ))}
              </span>
              <b>{x.group.length} threads</b>
              <span className="muted">{[...new Set(x.group.map((t) => t.messages[0]?.author.name))].slice(0, 3).join(', ')}</span>
            </div>
            <MessageText text={x.group[x.group.length - 1].messages.at(-1)?.text || ''} agents={agents} />
          </div>
        ) : x.id === '__draft' ? (
          <div key="__draft" ref={cardRef('__draft')} className={`mcard active ${draft.blockId ? '' : 'doc-level'}`} style={place('__draft')}>
            {!draft.blockId && (
              <div className="scope">
                <FileText className="i" style={{ width: 13, height: 13 }} /> On the whole doc
              </div>
            )}
            <Composer
              agents={agents}
              onSend={createThread}
              autoFocus
              sendLabel="Comment"
              initial={draft.mention ? `@${draft.mention} ` : ''}
              placeholder="Comment, or @mention an agent to ask it"
            />
            <div className="thread-actions">
              <button className="link" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ThreadCard
            key={x.id}
            cardRef={cardRef(x.id)}
            style={place(x.id)}
            t={x}
            active={x.id === activeThreadId}
            onOpen={setActiveThreadId}
            client={client}
            docId={doc.docId}
            agents={agents}
            toast={toast}
            onFocusBlock={onFocusBlock}
            now={now}
            showQuote={narrow || !(layout[x.id]?.level ?? true)}
            narrow={narrow}
          />
        ),
      )}
      {!items.length && (
        <div className="margin-empty" style={narrow ? undefined : { position: 'absolute', top: TOP }}>
          {showResolved ? 'No resolved threads.' : 'Select any words and comment. Mention @an agent to ask it for help.'}
        </div>
      )}
    </aside>
  );
}

export function HistoryDrawer({ client, doc, me, toast, onFocusBlock, onClose, initialTab = 'changes' }) {
  const ydoc = doc.ydoc;
  useY(proposalsOf(ydoc));
  useY(logOf(ydoc));
  useY(blocksOf(ydoc), false);
  const now = useNow();
  const [tab, setTab] = useState(initialTab);
  const proposals = [...proposalsOf(ydoc).values()].sort((a, b) => b.createdAt - a.createdAt);
  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'held');
  const past = proposals.filter((p) => !pending.includes(p)).slice(0, 30);
  const log = logOf(ydoc).toArray().slice().reverse();
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="History">
        <div className="pane-head">
          <nav className="tabs">
            <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
              Changes {pending.length > 0 && <span className="count">{pending.length}</span>}
            </button>
            <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
              Log
            </button>
          </nav>
          <button className="icon-btn" onClick={onClose} aria-label="Close history">
            <X className="i" />
          </button>
        </div>
        <div className="pane-body">
          {tab === 'changes' ? (
            <>
              {!pending.length && <div className="empty">Nothing waiting. Agents' suggestions appear in the text as tracked changes.</div>}
              {pending.map((p) => (
                <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} toast={toast} onFocusBlock={onFocusBlock} />
              ))}
              {past.length > 0 && <h4 className="sub">Earlier</h4>}
              {past.map((p) => (
                <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} toast={toast} onFocusBlock={onFocusBlock} />
              ))}
            </>
          ) : (
            <>
              <p className="hint" style={{ padding: '0 0 8px' }}>
                Every decision in this doc, in order. Typing merges continuously; threads, suggestions and approvals are recorded here.
              </p>
              {log.map((e) => (
                <div key={e.seq} className="log-row">
                  <span className="seq">#{e.seq}</span>
                  <span className={`avatar ${e.actor.kind === 'agent' ? 'agent' : 'human'} xs`}>{initials(e.actor.name)}</span>
                  <span>
                    <b>{e.actor.name}</b> {e.summary}
                  </span>
                  <span className="when">{ago(e.ts, now)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
