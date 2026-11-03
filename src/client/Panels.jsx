import { useEffect, useRef, useState } from 'react';
import { useY, useNow, ago, initials } from './hooks.js';
import { ProposalCard } from './Proposals.jsx';
import { threadsOf, proposalsOf, logOf, blocksOf, findBlock, encodeRel, resolveRel } from '../shared/schema.js';

function MessageText({ text, agents }) {
  const names = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const parts = text.split(/(@[\p{L}\p{N}_-]+)/u);
  return (
    <div className="msg-text">
      {parts.map((p, i) => {
        const a = p.startsWith('@') && (names.get(p.slice(1).toLowerCase()) || (['@agents', '@all'].includes(p.toLowerCase()) && { color: '#555' }));
        return a ? (
          <span key={i} className="mention" style={{ '--c': a.color }}>
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </div>
  );
}

function Composer({ agents, onSend, placeholder, autoFocus, initial = '' }) {
  const [text, setText] = useState(initial);
  const ref = useRef();
  useEffect(() => {
    setText(initial);
    if (autoFocus)
      setTimeout(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
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
    <div className="composer">
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
          {agents.map((a) => (
            <button key={a.id} className="chip" style={{ '--c': a.color }} onClick={() => insert(a.name)} title={a.description}>
              @{a.name}
            </button>
          ))}
          {agents.length > 1 && (
            <button className="chip" style={{ '--c': '#555' }} onClick={() => insert('agents')} title="Every agent in the space">
              @agents
            </button>
          )}
        </div>
        <button className="btn primary sm" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

function Typing({ thread, agents }) {
  const msgs = thread.messages;
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const involved = new Set(msgs.filter((m) => m.author.kind === 'agent').map((m) => m.author.id));
  for (const a of agents) if (new RegExp('@(' + a.name + '|agents|all)\\b', 'i').test(last.text)) involved.add(a.id);
  const busy = agents.filter((a) => involved.has(a.id) && ['thinking', 'working'].includes(a.status) && last.author.id !== a.id);
  const queued = agents.filter((a) => involved.has(a.id) && !busy.includes(a) && last.author.kind === 'human' && new RegExp('@(' + a.name + '|agents|all)\\b', 'i').test(last.text) && !a.online);
  return (
    <>
      {busy.map((a) => (
        <div key={a.id} className="typing" style={{ '--c': a.color }}>
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
          {a.name} is offline — it will pick this up when its computer reconnects.
        </div>
      ))}
    </>
  );
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
    resolved: t.get('resolved'),
    createdBy: t.get('createdBy'),
    createdAt: t.get('createdAt'),
    messages: t.get('messages').toArray(),
    orphan: blockId && !f,
  };
}

function ThreadCard({ t, active, onOpen, client, docId, agents, toast, onFocusBlock, now }) {
  const send = (text) =>
    client.rpc('thread.post', { docId, threadId: t.id, text }).catch((e) => {
      toast(e.message);
      return false;
    });
  return (
    <div className={`thread-card ${active ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`} onClick={() => !active && onOpen(t.id)}>
      {t.quote ? (
        <button
          className="quote"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(t.id);
            if (t.blockId) onFocusBlock(t.blockId);
          }}
        >
          {t.orphan ? <s>{t.quote}</s> : t.quote}
        </button>
      ) : (
        <div className="quote doc-level">Whole doc</div>
      )}
      <div className="messages">
        {(active ? t.messages : t.messages.slice(-2)).map((m) => (
          <div key={m.id} className={`msg ${m.author.kind}`}>
            <span className={`avatar ${m.author.kind} sm`} style={{ '--c': m.author.color }}>
              {initials(m.author.name)}
            </span>
            <div className="msg-body">
              <div className="msg-meta">
                <b>{m.author.name}</b>
                {m.author.kind === 'agent' && <span className="badge">agent</span>}
                <span className="muted">{ago(m.ts, now)}</span>
              </div>
              <MessageText text={m.text} agents={agents} />
            </div>
          </div>
        ))}
        {!active && t.messages.length > 2 && <div className="muted more">+{t.messages.length - 2} earlier</div>}
      </div>
      <Typing thread={t} agents={agents} />
      {active && (
        <div onClick={(e) => e.stopPropagation()}>
          <Composer agents={agents} onSend={send} placeholder="Reply… @mention an agent to bring it in" autoFocus />
          <div className="thread-actions">
            <button className="link" onClick={() => client.rpc('thread.resolve', { docId, threadId: t.id, resolved: !t.resolved }).catch((e) => toast(e.message))}>
              {t.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RightPanel({ client, doc, space, me, tab, setTab, activeThreadId, setActiveThreadId, draft, setDraft, toast, onFocusBlock }) {
  const ydoc = doc.ydoc;
  useY(threadsOf(ydoc));
  useY(proposalsOf(ydoc));
  useY(logOf(ydoc));
  useY(blocksOf(ydoc), false);
  const now = useNow();
  const [showResolved, setShowResolved] = useState(false);
  const agents = space.agents;
  const threads = [...threadsOf(ydoc).values()].map((t) => threadView(ydoc, t)).sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start);
  const open = threads.filter((t) => !t.resolved);
  const shown = showResolved ? threads.filter((t) => t.resolved) : open;
  const proposals = [...proposalsOf(ydoc).values()].sort((a, b) => b.createdAt - a.createdAt);
  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'held');
  const log = logOf(ydoc).toArray().slice().reverse();

  useEffect(() => {
    if (activeThreadId) document.querySelector(`[data-thread="${activeThreadId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeThreadId]);

  const createThread = async (text) => {
    try {
      let args = { docId: doc.docId, text };
      if (draft.blockId) {
        const f = findBlock(ydoc, draft.blockId);
        if (!f) throw new Error('That block was deleted');
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

  return (
    <aside className="right">
      <nav className="tabs">
        <button className={tab === 'threads' ? 'on' : ''} onClick={() => setTab('threads')}>
          Threads <span className="count">{open.length}</span>
        </button>
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          Changes <span className={`count ${pending.length ? 'hot' : ''}`}>{pending.length}</span>
        </button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          Log
        </button>
      </nav>
      {tab === 'threads' && (
        <div className="panel">
          {draft ? (
            <div className="thread-card active draft">
              {draft.quote ? <div className="quote">{draft.quote}</div> : <div className="quote doc-level">Whole doc</div>}
              <Composer
                agents={agents}
                onSend={createThread}
                autoFocus
                initial={draft.mention ? `@${draft.mention} ` : ''}
                placeholder="Comment, or @mention an agent to ask it something…"
              />
              <div className="thread-actions">
                <button className="link" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="btn ghost full" onClick={() => setDraft({ blockId: null })}>
              + New thread on the whole doc
            </button>
          )}
          {shown.map((t) => (
            <div key={t.id} data-thread={t.id}>
              <ThreadCard
                t={t}
                active={t.id === activeThreadId}
                onOpen={setActiveThreadId}
                client={client}
                docId={doc.docId}
                agents={agents}
                toast={toast}
                onFocusBlock={onFocusBlock}
                now={now}
              />
            </div>
          ))}
          {!shown.length && !draft && (
            <div className="empty">
              {showResolved ? 'No resolved threads.' : 'Select text in the doc and comment, or @mention an agent to bring it in.'}
            </div>
          )}
          <button className="link center" onClick={() => setShowResolved((x) => !x)}>
            {showResolved ? 'Show open threads' : `Show resolved (${threads.length - open.length})`}
          </button>
        </div>
      )}
      {tab === 'changes' && (
        <div className="panel">
          {!pending.length && <div className="empty">No changes waiting. Agents' suggestions appear here and inline in the doc.</div>}
          {pending.map((p) => (
            <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} toast={toast} onFocusBlock={onFocusBlock} />
          ))}
          {proposals.length > pending.length && <h4 className="sub">History</h4>}
          {proposals
            .filter((p) => !pending.includes(p))
            .slice(0, 30)
            .map((p) => (
              <ProposalCard key={p.id} p={p} ydoc={ydoc} client={client} docId={doc.docId} me={me} toast={toast} onFocusBlock={onFocusBlock} />
            ))}
        </div>
      )}
      {tab === 'log' && (
        <div className="panel log">
          <p className="muted small">Every decision in this doc, in order. Text edits merge continuously (CRDT); threads, proposals and approvals are recorded here.</p>
          {log.map((e) => (
            <div key={e.seq} className="log-row">
              <span className="seq">#{e.seq}</span>
              <span className={`avatar ${e.actor.kind === 'agent' ? 'agent' : 'human'} xs`} style={{ '--c': e.actor.color || '#888' }}>
                {initials(e.actor.name)}
              </span>
              <span>
                <b>{e.actor.name}</b> {e.summary}
              </span>
              <span className="muted when">{ago(e.ts, now)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
