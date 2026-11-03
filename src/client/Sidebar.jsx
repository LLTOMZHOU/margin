import { useEffect, useState } from 'react';
import { FileText, Users, SlidersHorizontal, Plus, Trash2, Sparkles, MoreHorizontal, X, ShieldCheck, Globe } from 'lucide-react';
import { initials, ago, useNow } from './hooks.js';


function SetupCommands({ token, agent, origin }) {
  const profile = agent.name.toLowerCase();
  const [tab, setTab] = useState('cli');
  const blocks = {
    cli: [
      `# 1. Save the credential as a profile (paste the token when asked; it stays out of shell history)`,
      `margin login --server ${origin} --profile ${profile}`,
      `# 2. Keep the agent online and wake it on mentions`,
      `MARGIN_PROFILE=${profile} margin bridge --runtime codex`,
      `#    (runtimes: codex · claude-code · claude-api · sim)`,
    ],
    mcp: [
      `# Interactive: let your Codex or Claude Code session be @${agent.name}`,
      `margin login --server ${origin} --profile ${profile}   # paste the token`,
      `codex mcp add margin --env MARGIN_PROFILE=${profile} -- margin mcp`,
      `claude mcp add margin -e MARGIN_PROFILE=${profile} -- margin mcp`,
      `# then: "use the margin-agent skill; check your inbox and keep working"`,
    ],
    sdk: [
      `// Any process: same contract as the CLI`,
      `import { AgentClient } from 'margin-hub/src/agent/client.js';`,
      `const api = new AgentClient({ server: '${origin}', token: process.env.MARGIN_TOKEN });`,
      `let since; for (;;) { const b = await api.inbox(since); /* handle b.data.events */ since = b.data.cursor; }`,
    ],
  };
  return (
    <div className="setup">
      <div className="token-row">
        <code className="token">{token}</code>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(token)}>
          Copy
        </button>
      </div>
      <p className="muted small">Shown once. It is stored hashed; revoke it any time from the agent's settings.</p>
      <nav className="mini-tabs">
        {[
          ['cli', 'Bridge (CLI)'],
          ['mcp', 'Codex / Claude Code (MCP)'],
          ['sdk', 'Your own code'],
        ].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </nav>
      <pre className="cmd">{blocks[tab].join('\n')}</pre>
    </div>
  );
}

function SafetyControls({ scope, setScope, quarantine, setQuarantine, runtime }) {
  return (
    <>
      <label>
        What it may touch
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="wake">Only what it's asked about (recommended)</option>
          <option value="space">Anything in this space (trusted agents only)</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={quarantine} onChange={(e) => setQuarantine(e.target.checked)} disabled={runtime === 'external'} />
        <span>
          Quarantined reader
          <span className="muted small">
            {' '}
            The model that reads the doc gets no tools; plain code applies its answer. Strongest protection against instructions hidden in docs, but the agent can only edit, comment and reply.
          </span>
        </span>
      </label>
    </>
  );
}

function AddAgent({ client, space, onClose, toast }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [runtime, setRuntime] = useState('sim');
  const [scope, setScope] = useState('wake');
  const [quarantine, setQuarantine] = useState(false);
  const [created, setCreated] = useState(null);
  const create = async () => {
    try {
      const r = await client.rpc('agent.create', { name, description, runtime, scope, quarantine });
      if (r.token) setCreated({ token: r.token, agent: { name: name.trim().replace(/\s+/g, '-') } });
      else onClose();
    } catch (e) {
      toast(e.message);
    }
  };
  if (created)
    return (
      // The token is shown once: only the Done button closes this, never a stray backdrop click.
      <div className="modal">
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h3>Connect @{created.agent.name}</h3>
          <p className="muted">Run it on any machine. The bridge holds a stream to this space, receives content-free wake hints, and starts your runtime, which reads and replies through the agent API.</p>
          <SetupCommands token={created.token} agent={created.agent} origin={location.origin} />
          <div className="sheet-actions">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Add an agent</h3>
        <label>
          Name <span className="muted">(people will @mention it)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Researcher" autoFocus />
        </label>
        <label>
          Role
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this agent is responsible for, and what it should not do." />
        </label>
        <label>
          Where it runs
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            {Object.entries(space.runtimes).map(([k, v]) => (
              <option key={k} value={k}>
                {k === 'external' ? v : `This computer · ${v}`}
              </option>
            ))}
          </select>
        </label>
        <SafetyControls scope={scope} setScope={setScope} quarantine={quarantine} setQuarantine={setQuarantine} runtime={runtime} />
        <p className="muted small">
          “This computer” agents are hosted by any `margin computer` connected to this hub. “External” gives you a credential to run the agent anywhere.
        </p>
        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={name.trim().length < 2} onClick={create}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentSettings({ client, space, agent, onClose, toast }) {
  const [description, setDescription] = useState(agent.description);
  const [runtime, setRuntime] = useState(agent.runtime);
  const [scope, setScope] = useState(agent.scope || 'wake');
  const [quarantine, setQuarantine] = useState(!!agent.quarantine);
  const [token, setToken] = useState(null);
  const save = async () => {
    try {
      await client.rpc('agent.update', { agentId: agent.id, description, runtime, scope, quarantine });
      onClose();
    } catch (e) {
      toast(e.message);
    }
  };
  return (
    <div className="modal" onClick={() => !token && onClose()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>
          <span className="avatar agent">{initials(agent.name)}</span>
          @{agent.name}
        </h3>
        <label>
          Role
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Where it runs
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            {Object.entries(space.runtimes).map(([k, v]) => (
              <option key={k} value={k}>
                {k === 'external' ? v : `This computer · ${v}`}
              </option>
            ))}
          </select>
        </label>
        <SafetyControls scope={scope} setScope={setScope} quarantine={quarantine} setQuarantine={setQuarantine} runtime={runtime} />
        <h4 className="sub" style={{ marginTop: 4 }}>Credentials</h4>
        {agent.tokens.map((t) => (
          <div key={t.prefix} className="cred">
            <code>{t.prefix}…</code> <span className="muted small">{t.label}</span>
            <button className="link" onClick={() => client.rpc('agent.revoke', { agentId: agent.id, prefix: t.prefix }).catch((e) => toast(e.message))}>
              revoke
            </button>
          </div>
        ))}
        {token ? (
          <SetupCommands token={token} agent={agent} origin={location.origin} />
        ) : (
          <button className="btn sm" onClick={async () => setToken((await client.rpc('agent.mint', { agentId: agent.id })).token)}>
            Generate a credential to run it elsewhere
          </button>
        )}
        <div className="sheet-actions">
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Remove @${agent.name} from the space? Its credentials stop working immediately.`)) client.rpc('agent.remove', { agentId: agent.id }).then(onClose, (e) => toast(e.message));
            }}
          >
            Remove
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function Logo({ className = 'mark' }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-label="Margin">
      <rect width="64" height="64" rx="14" fill="#1c1b19" />
      <rect x="12" y="17" width="24" height="3.5" rx="1.75" fill="#fbf9f4" />
      <rect x="12" y="26" width="20" height="3.5" rx="1.75" fill="#fbf9f4" opacity=".85" />
      <rect x="12" y="35" width="24" height="3.5" rx="1.75" fill="#fbf9f4" opacity=".7" />
      <rect x="12" y="44" width="14" height="3.5" rx="1.75" fill="#fbf9f4" opacity=".55" />
      <rect x="41" y="13" width="2" height="38" rx="1" fill="#f5c84c" />
      <path d="M46 22h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-4l-3 3v-3h-1a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z" fill="#f5c84c" />
    </svg>
  );
}

const PANES = [
  ['docs', FileText, 'Docs'],
  ['members', Users, 'People and agents'],
  ['instructions', SlidersHorizontal, 'Space instructions'],
];

export function Rail({ pane, setPane, me, connection }) {
  return (
    <nav className="rail" aria-label="Space">
      <Logo />
      {PANES.map(([k, Icon, label]) => (
        <button key={k} className={`icon-btn ${pane === k ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={pane === k} onClick={() => setPane(pane === k ? null : k)}>
          <Icon className="i" />
        </button>
      ))}
      <span className="grow" />
      <span className={`conn-dot ${connection}`} title={connection === 'online' ? 'Connected' : 'Reconnecting…'} />
      <span className="avatar me" title={`${me.name} (you)`}>
        {initials(me.name)}
      </span>
    </nav>
  );
}

function Pane({ title, onClose, children, action }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="flyout" aria-label={title}>
        <div className="pane-head">
          <h3>{title}</h3>
          <span style={{ display: 'flex', gap: 2 }}>
            {action}
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X className="i" />
            </button>
          </span>
        </div>
        <div className="pane-body">{children}</div>
      </section>
    </>
  );
}

export function DocsPane({ client, space, docId, setDocId, toast, onClose }) {
  const create = async () => {
    const r = await client.rpc('doc.create', { title: 'Untitled doc' });
    setDocId(r.docId);
    onClose();
  };
  return (
    <Pane
      title={space.name}
      onClose={onClose}
      action={
        <button className="icon-btn" title="New doc" aria-label="New doc" onClick={create}>
          <Plus className="i" />
        </button>
      }
    >
      <div className="pane-label">Docs</div>
      {space.docs.map((d) => (
        <div
          key={d.id}
          className={`row ${d.id === docId ? 'on' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => (setDocId(d.id), onClose())}
          onKeyDown={(e) => e.key === 'Enter' && (setDocId(d.id), onClose())}
        >
          <FileText className="i" style={{ color: 'var(--ink-3)' }} />
          <span className="name">{d.title || 'Untitled'}</span>
          {space.docs.length > 1 && (
            <button
              className="icon-btn hover-only"
              title="Delete doc"
              aria-label={`Delete ${d.title || 'Untitled'}`}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete “${d.title || 'Untitled'}” for everyone? This can't be undone.`))
                  client.rpc('doc.remove', { docId: d.id }).then(() => d.id === docId && setDocId(space.docs.find((x) => x.id !== d.id).id), (er) => toast(er.message));
              }}
            >
              <Trash2 className="i" />
            </button>
          )}
        </div>
      ))}
    </Pane>
  );
}

export function MembersPane({ client, space, me, docId, toast, onClose }) {
  const now = useNow(5000);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(null);
  const ask = (a, request) =>
    client.rpc('agent.ask', { docId, agentId: a.id, request }).then(() => toast(a.id === '*' ? 'Asked every agent to review this doc.' : `Asked @${a.name} to review this doc.`), (e) => toast(e.message));
  const humans = space.humans.slice().sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  return (
    <Pane title="People and agents" onClose={onClose}>
      <section className="pane-section">
        <div className="pane-label">
          Agents
          <button className="link" onClick={() => setAdding(true)}>
            <Plus className="i" style={{ width: 13, height: 13, verticalAlign: -2 }} /> Add
          </button>
        </div>
        {space.agents.map((a) => (
          <div key={a.id} className="row">
            <span className={`avatar agent st-${a.status}`}>{initials(a.name)}</span>
            <span className="name">{a.name}</span>
            {a.quarantine && (
              <span className="flag" title="Quarantined reader: the model that reads docs has no tools" aria-label="Quarantined reader">
                <ShieldCheck className="i" />
              </span>
            )}
            {a.scope === 'space' && (
              <span className="flag" title="Space-wide: may act anywhere in the space, not just where it was asked" aria-label="Space-wide">
                <Globe className="i" />
              </span>
            )}
            <span className={`meta status st-${a.status}`} title={a.detail || ''}>
              <i />
              {a.status === 'offline' ? (a.lastSeen ? ago(a.lastSeen, now) : 'offline') : a.pending > 0 ? `${a.pending} waiting` : a.status}
            </span>
            <button className="icon-btn hover-only" title={`Ask @${a.name} to review this doc`} aria-label={`Ask ${a.name} to review`} onClick={() => ask(a, 'please review this doc in your specialty.')}>
              <Sparkles className="i" />
            </button>
            <button className="icon-btn hover-only" title="Settings" aria-label={`${a.name} settings`} onClick={() => setSettings(a)}>
              <MoreHorizontal className="i" />
            </button>
          </div>
        ))}
        {space.agents.length > 1 && (
          <button className="btn quiet sm full" style={{ marginTop: 4, justifyContent: 'flex-start' }} onClick={() => ask({ id: '*' }, 'please each review this doc in your specialty. Coordinate: one agent per block.')}>
            <Sparkles className="i" /> Ask every agent to review
          </button>
        )}
      </section>
      <section className="pane-section">
        <div className="pane-label">People</div>
        {humans.map((h) => (
          <div key={h.id} className="row">
            <span className={`avatar ${h.id === me.id ? 'me' : ''} ${h.online ? '' : 'off'}`}>{initials(h.name)}</span>
            <span className="name">
              {h.name}
              {h.id === me.id ? ' (you)' : ''}
            </span>
            <span className="meta">{h.online ? 'here' : ago(h.lastSeen, now)}</span>
          </div>
        ))}
      </section>
      {adding && <AddAgent client={client} space={space} onClose={() => setAdding(false)} toast={toast} />}
      {settings && <AgentSettings client={client} space={space} agent={space.agents.find((a) => a.id === settings.id) || settings} onClose={() => setSettings(null)} toast={toast} />}
    </Pane>
  );
}

export function InstructionsPane({ client, space, toast, onClose }) {
  const [text, setText] = useState(space.instructions);
  const save = () => text !== space.instructions && client.rpc('space.instructions', { text }).catch((e) => toast(e.message));
  return (
    <Pane title="Space instructions" onClose={() => (save(), onClose())}>
      <p className="hint">Every agent reads this before it acts: goals, audience, tone, rules.</p>
      <textarea className="field" rows={14} value={text} onChange={(e) => setText(e.target.value)} onBlur={save} autoFocus style={{ resize: 'vertical' }} />
    </Pane>
  );
}
