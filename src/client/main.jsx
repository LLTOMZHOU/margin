import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HubClient } from '../shared/sync.js';
import { uid } from '../shared/schema.js';
import { Sidebar } from './Sidebar.jsx';
import { DocView } from './DocView.jsx';
import { RightPanel } from './Panels.jsx';
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
        <div className="logo">◐ Margin</div>
        <p>This hub is private. Paste the access key from your invite link.</p>
        <label>
          Access key
          <input value={k} onChange={(e) => setK(e.target.value)} autoFocus />
        </label>
        <button
          className="btn primary full"
          style={{ marginTop: 16 }}
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
  const [color, setColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);
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
        <div className="logo">◐ Margin</div>
        <p>A shared doc for many people and many agents. Agents run on your own computers and suggest; humans decide.</p>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} autoFocus placeholder="e.g. Ada" />
        </label>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
        </div>
        <button className="btn primary full" onClick={go} disabled={!name.trim()}>
          Join the space
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

function Space({ user, spaceId, docIdParam, setUrl }) {
  const [client, setClient] = useState(null);
  const [space, setSpace] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [tab, setTab] = useState('threads');
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [toasts, setToasts] = useState([]);
  const toast = (text) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

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

  if (!client || !space || !doc || doc.docId !== docId) return <div className="loading full">Connecting…</div>;

  const focusBlock = (blockId) => {
    const el = document.querySelector(`[data-block="${blockId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('pinged');
    setTimeout(() => el?.classList.remove('pinged'), 1200);
  };

  return (
    <div className="app">
      <Sidebar
        client={client}
        space={space}
        me={user}
        docId={docId}
        setDocId={(id) => {
          setActiveThreadId(null);
          setDraft(null);
          setUrl({ space: spaceId, doc: id });
        }}
        toast={toast}
        connection={connection}
      />
      <main className="center">
        <DocView
          key={doc.docId}
          client={client}
          doc={doc}
          space={space}
          me={user}
          activeThreadId={activeThreadId}
          setActiveThreadId={(id) => {
            setActiveThreadId(id);
            setTab('threads');
          }}
          onStartComment={(d) => {
            setDraft(d);
            setActiveThreadId(null);
            setTab('threads');
          }}
          toast={toast}
        />
      </main>
      <RightPanel
        key={'r' + doc.docId}
        client={client}
        doc={doc}
        space={space}
        me={user}
        tab={tab}
        setTab={setTab}
        activeThreadId={activeThreadId}
        setActiveThreadId={setActiveThreadId}
        draft={draft}
        setDraft={setDraft}
        toast={toast}
        onFocusBlock={focusBlock}
      />
      <div className="toasts">
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
