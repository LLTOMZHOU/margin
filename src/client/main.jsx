import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, MessageSquare, History, MoreHorizontal, Sparkles, Plus, Trash2, Menu } from 'lucide-react';
import { HubClient } from '../shared/sync.js';
import { uid, metaOf, proposalsOf, threadsOf } from '../shared/schema.js';
import { Rail, Logo, DocsPane, MembersPane, InstructionsPane } from './Sidebar.jsx';
import { DocView } from './DocView.jsx';
import { Margin, HistoryDrawer } from './Panels.jsx';
import { useY, useDocEvent, initials } from './hooks.js';
import './styles.css';

// Hosted hubs are protected by an access key. Invite links carry it as ?key=…
const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) localStorage.setItem('margin.key', urlKey);
const accessKey = () => localStorage.getItem('margin.key') || '';

function KeyPrompt() {
  const [k, setK] = useState('');
  return (
    <div className="join">
      <div className="join-card">
        <Logo />
        <h1>This hub is private</h1>
        <p>Paste the access key from your invite link.</p>
        <label>
          Access key
          <input value={k} onChange={(e) => setK(e.target.value)} autoFocus />
        </label>
        <button
          className="btn primary full"
          disabled={!k.trim()}
          onClick={() => {
            localStorage.setItem('margin.key', k.trim());
            location.reload();
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// Only carets and selections use a person's colour; everything else stays neutral.
const COLORS = ['#c2410c', '#0369a1', '#15803d', '#7e22ce', '#be123c', '#4d7c0f', '#b45309', '#0e7490'];

// Identity is per tab (sessionStorage), so two tabs can be two different people.
function loadUser() {
  try {
    return JSON.parse(sessionStorage.getItem('margin.user'));
  } catch {
    return null;
  }
}

function Join({ onJoin }) {
  const last = localStorage.getItem('margin.lastName') || '';
  const [name, setName] = useState(new URLSearchParams(location.search).get('as') || last);
  const [color] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);
  const go = () => {
    if (!name.trim()) return;
    const u = { id: uid('u'), name: name.trim().slice(0, 40), color };
    sessionStorage.setItem('margin.user', JSON.stringify(u));
    localStorage.setItem('margin.lastName', u.name);
    onJoin(u);
  };
  useEffect(() => {
    if (new URLSearchParams(location.search).get('as')) go();
  }, []);
  return (
    <div className="join">
      <div className="join-card">
        <Logo />
        <h1>Join this space</h1>
        <p>People and agents write here together. Agents suggest; people decide.</p>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} autoFocus placeholder="e.g. Ada" />
        </label>
        <button className="btn primary full" onClick={go} disabled={!name.trim()}>
          Join
        </button>
      </div>
    </div>
  );
}

function useUrlState() {
  const read = () => Object.fromEntries(new URLSearchParams(location.search));
  const [state, setState] = useState(read);
  useEffect(() => {
    const f = () => setState(read());
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);
  const update = (patch) => {
    const next = { ...read(), ...patch };
    delete next.as;
    delete next.key;
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
    history.pushState(null, '', '?' + qs);
    setState(next);
  };
  return [state, update];
}

const POLICY_SHORT = { auto: 'Edits apply instantly', one: 'Any one person approves', majority: 'Majority approves' };

function useNarrow() {
  const q = '(max-width: 900px)';
  const [narrow, set] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const f = () => set(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return narrow;
}

function Topbar({ client, doc, space, me, docId, toast, onPane, threadsOpen, onThreads, onHistory, narrow }) {
  const ydoc = doc.ydoc;
  useY(metaOf(ydoc), false);
  useY(proposalsOf(ydoc));
  useY(threadsOf(ydoc));
  useDocEvent(doc, 'presence');
  const [menu, setMenu] = useState(null);
  const [nav, setNav] = useState(null);
  const title = metaOf(ydoc).get('title') || 'Untitled';
  const policy = metaOf(ydoc).get('policy') || 'one';
  const pending = [...proposalsOf(ydoc).values()].filter((p) => p.status === 'pending' || p.status === 'held').length;
  const openThreads = [...threadsOf(ydoc).values()].filter((t) => !t.get('resolved')).length;
  // One face per person or agent, however many tabs they have open.
  const here = [...new Map((doc.presence || []).map((p) => [p.kind + ':' + p.id, p])).values()];
  const shown = here.slice(0, 5);
  const ask = () => client.rpc('agent.ask', { docId, agentId: '*', request: 'please each review this doc in your specialty. Coordinate: one agent per block.' }).then(() => toast('Asked every agent to review this doc.'), (e) => toast(e.message));
  return (
    <header className="topbar">
      <button
        className="icon-btn mobile-only"
        aria-label="Menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNav({ top: r.bottom + 6, left: r.left });
        }}
      >
        <Menu className="i" />
      </button>
      {nav && (
        <>
          <div className="scrim" onClick={() => setNav(null)} />
          <div className="menu" style={{ top: nav.top, left: nav.left }} role="menu">
            {[
              ['docs', 'Docs'],
              ['members', 'People and agents'],
              ['instructions', 'Space instructions'],
            ].map(([k, label]) => (
              <button key={k} className="row" role="menuitem" onClick={() => (setNav(null), onPane(k))}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <button className="crumb" onClick={() => onPane('docs')} title="Switch doc">
        <span className="space wide-only">{space.name} /</span>
        <span className="title">{title}</span>
        <ChevronDown className="i" style={{ width: 14, height: 14, color: 'var(--ink-3)' }} />
      </button>
      <span className="grow" />
      <button className="here crumb wide-only" onClick={() => onPane('members')} title="People and agents">
        <span className="stack">
          {shown.map((p) => (
            <span key={p.kind + (p.connId || p.id)} className={`avatar ${p.kind === 'agent' ? `agent st-${p.status}` : p.id === me.id ? 'me' : ''}`} title={`${p.name}${p.id === me.id ? ' (you)' : ''}${p.kind === 'agent' ? ` · ${p.status}` : ''}`}>
              {initials(p.name)}
            </span>
          ))}
        </span>
        <span className="count-text">{here.length} here</span>
      </button>
      <span className="vsep wide-only" />
      <label className="policy wide-only" title={`Who must approve an agent's edit: ${space.policies[policy]}`}>
        <select value={policy} aria-label="Who approves agent edits" onChange={(e) => client.rpc('doc.policy', { docId, policy: e.target.value }).catch((er) => toast(er.message))}>
          {Object.keys(space.policies).map((k) => (
            <option key={k} value={k}>
              {POLICY_SHORT[k] || space.policies[k]}
            </option>
          ))}
        </select>
        <ChevronDown className="i chev" />
      </label>
      <span className="vsep wide-only" />
      <button className={`icon-btn counted ${threadsOpen ? 'on' : ''}`} title={narrow ? 'Threads' : threadsOpen ? 'Hide threads' : 'Show threads'} aria-label={`Threads, ${openThreads} open`} aria-pressed={threadsOpen} onClick={onThreads}>
        <MessageSquare className="i" />
        {openThreads > 0 && <span className="n">{openThreads}</span>}
      </button>
      <button className="icon-btn counted" title="History: suggested changes and the log" aria-label={`History, ${pending} waiting for review`} onClick={onHistory}>
        <History className="i" />
        {pending > 0 && <span className="n hot">{pending}</span>}
      </button>
      <button
        className="icon-btn"
        title="More"
        aria-label="More"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ top: r.bottom + 6, right: innerWidth - r.right });
        }}
      >
        <MoreHorizontal className="i" />
      </button>
      {menu && (
        <>
          <div className="scrim" onClick={() => setMenu(null)} />
          <div className="menu" style={{ top: menu.top, right: menu.right }} role="menu">
            {space.agents.length > 0 && (
              <button className="row" role="menuitem" onClick={() => (setMenu(null), ask())}>
                <Sparkles className="i" /> Ask every agent to review
              </button>
            )}
            <button
              className="row"
              role="menuitem"
              onClick={async () => {
                setMenu(null);
                const r = await client.rpc('doc.create', { title: 'Untitled doc' });
                onPane(null, r.docId);
              }}
            >
              <Plus className="i" /> New doc
            </button>
            {space.docs.length > 1 && (
              <button
                className="row danger"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  if (confirm(`Delete “${title}” for everyone? This can't be undone.`))
                    client.rpc('doc.remove', { docId }).then(() => onPane(null, space.docs.find((x) => x.id !== docId).id), (er) => toast(er.message));
                }}
              >
                <Trash2 className="i" /> Delete this doc
              </button>
            )}
          </div>
        </>
      )}
    </header>
  );
}

function Space({ user, spaceId, docIdParam, setUrl }) {
  const [client, setClient] = useState(null);
  const [space, setSpace] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [pane, setPane] = useState(null);
  const [history, setHistory] = useState(false);
  const narrow = useNarrow();
  const [marginOpen, setMarginOpen] = useState(!narrow);
  const pageRef = useRef();
  const [toasts, setToasts] = useState([]);
  const toast = (text) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  useEffect(() => setMarginOpen(!narrow), [narrow]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const c = new HubClient({ url: `${proto}://${location.host}/ws?key=${encodeURIComponent(accessKey())}`, user, spaceId });
    c.spaceListeners.add(setSpace);
    c.statusListeners.add(setConnection);
    setClient(c);
    return () => {
      c.close();
      setClient(null);
      setSpace(null);
    };
  }, [user, spaceId]);

  const docId = space && (space.docs.some((d) => d.id === docIdParam) ? docIdParam : space.docs[0]?.id);
  const [doc, setDoc] = useState(null);
  useEffect(() => {
    if (!client || !docId) return;
    const d = client.openDoc(docId);
    setDoc(d);
    return () => {
      client.closeDoc(docId);
      setDoc(null);
    };
  }, [client, docId]);

  useEffect(() => {
    if (space) document.title = `${space.docs.find((d) => d.id === docId)?.title || 'Doc'} · ${space.name}`;
  }, [space, docId]);

  // Esc closes the open thread (the drawers and flyouts handle their own Esc).
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && !pane && !history && (setActiveThreadId(null), setDraft(null));
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [pane, history]);

  if (!client || !space || !doc || doc.docId !== docId) return <div className="loading full">Connecting…</div>;

  const setDocId = (id) => {
    setActiveThreadId(null);
    setDraft(null);
    setUrl({ space: spaceId, doc: id });
  };
  // Bring a block into view. On phones the thread sheet covers the lower part, so the block goes to the top.
  const focusBlock = (blockId, { quiet, top } = {}) => {
    const el = document.querySelector(`[data-block="${blockId}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (top) {
      const canvas = document.querySelector('.canvas');
      canvas.scrollTo({ top: canvas.scrollTop + r.top - 72, behavior: 'smooth' });
    } else if (!quiet || r.top < 80 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (quiet) return;
    el.classList.add('pinged');
    setTimeout(() => el.classList.remove('pinged'), 1200);
  };
  const openThread = (id) => {
    setDraft(null);
    setActiveThreadId(id);
    if (id) setMarginOpen(true);
  };
  const showMargin = marginOpen || narrow;

  return (
    <div className="app">
      <Rail pane={pane} setPane={setPane} me={user} connection={connection} />
      <div className="main">
        <Topbar
          client={client}
          doc={doc}
          space={space}
          me={user}
          docId={docId}
          toast={toast}
          narrow={narrow}
          onPane={(p, newDoc) => {
            if (newDoc) setDocId(newDoc);
            setPane(p);
          }}
          threadsOpen={marginOpen}
          onThreads={() => setMarginOpen((x) => !x)}
          onHistory={() => setHistory(true)}
        />
        <main className="canvas">
          <div ref={pageRef} className={`page ${activeThreadId || draft ? 'focus' : ''} ${showMargin ? '' : 'no-margin'}`}>
            <DocView
              key={doc.docId}
              client={client}
              doc={doc}
              space={space}
              me={user}
              activeThreadId={activeThreadId}
              onOpenThread={(tid, blockId) => {
                openThread(tid);
                // On phones the sheet rises over the lower screen: move the tapped passage above it.
                if (narrow) setTimeout(() => focusBlock(blockId, { quiet: true, top: true }), 60);
              }}
              onStartComment={(d) => {
                setActiveThreadId(null);
                setDraft(d);
                setMarginOpen(true);
              }}
              toast={toast}
            />
            {showMargin && (
              <Margin
                key={'m' + doc.docId}
                client={client}
                doc={doc}
                space={space}
                me={user}
                activeThreadId={activeThreadId}
                setActiveThreadId={openThread}
                draft={draft}
                setDraft={setDraft}
                toast={toast}
                onFocusBlock={focusBlock}
                pageRef={pageRef}
                narrow={narrow}
                open={marginOpen}
                onClose={() => setMarginOpen(false)}
              />
            )}
          </div>
        </main>
      </div>
      {pane === 'docs' && <DocsPane client={client} space={space} docId={docId} setDocId={setDocId} toast={toast} onClose={() => setPane(null)} />}
      {pane === 'members' && <MembersPane client={client} space={space} me={user} docId={docId} toast={toast} onClose={() => setPane(null)} />}
      {pane === 'instructions' && <InstructionsPane client={client} space={space} toast={toast} onClose={() => setPane(null)} />}
      {history && <HistoryDrawer client={client} doc={doc} me={user} toast={toast} onFocusBlock={(id) => (setHistory(false), setTimeout(() => focusBlock(id), 50))} onClose={() => setHistory(false)} />}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(loadUser);
  const [url, setUrl] = useUrlState();
  const [spaceId, setSpaceId] = useState(url.space || null);
  const [needKey, setNeedKey] = useState(false);
  useEffect(() => {
    const headers = { 'x-margin-key': accessKey(), 'content-type': 'application/json' };
    fetch('/api/spaces', { headers })
      .then((r) => {
        if (r.status === 403) throw new Error('key');
        return r.json();
      })
      .then(async (list) => {
        if (url.space) return setSpaceId(url.space);
        const id = list[0]?.id || (await (await fetch('/api/spaces', { method: 'POST', headers, body: '{"name":"My space"}' })).json()).id;
        setUrl({ space: id });
        setSpaceId(id);
      })
      .catch((e) => e.message === 'key' && setNeedKey(true));
  }, [url.space]);
  if (needKey) return <KeyPrompt />;
  if (!user) return <Join onJoin={setUser} />;
  if (!spaceId) return <div className="loading full">Loading…</div>;
  return <Space user={user} spaceId={spaceId} docIdParam={url.doc} setUrl={setUrl} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
