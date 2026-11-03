import { useState } from 'react';
import { initials, ago, useNow } from './hooks.js';

const STATUS_TEXT = { online: 'Online', thinking: 'Thinking', working: 'Working', error: 'Error', offline: 'Offline' };

function SetupCommands({ token, agent, origin }) {
  const root = '<path-to>/margin_project';
  const profile = agent.name.toLowerCase();
  const [tab, setTab] = useState('cli');
  const blocks = {
    cli: [
      `# 1. Save the credential as a profile (paste the token when asked; it stays out of shell history)`,
      `node ${root}/bin/margin.js login --server ${origin} --profile ${profile}`,
      `# 2. Keep the agent online and wake it on mentions`,
      `MARGIN_PROFILE=${profile} node ${root}/bin/margin.js bridge --runtime codex`,
      `#    (runtimes: codex · claude-code · claude-api · sim)`,
    ],
    mcp: [
      `# Interactive: let your Codex or Claude Code session be @${agent.name}`,
      `node ${root}/bin/margin.js login --server ${origin} --profile ${profile}   # paste the token`,
      `codex mcp add margin --env MARGIN_PROFILE=${profile} -- node ${root}/mcp/server.js`,
      `claude mcp add margin -e MARGIN_PROFILE=${profile} -- node ${root}/mcp/server.js`,
      `# then: "use the margin-agent skill; check your inbox and keep working"`,
    ],
    sdk: [
      `// Any process: same contract as the CLI`,
      `import { AgentClient } from '${root}/src/agent/client.js';`,
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
          <span className="avatar agent" style={{ '--c': agent.color }}>
            {initials(agent.name)}
          </span>{' '}
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
        <h4 className="sub">Credentials</h4>
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

export function Sidebar({ client, space, me, docId, setDocId, toast, connection }) {
  const now = useNow(5000);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(null);
  const [instr, setInstr] = useState(null);
  const ask = (a, request) => client.rpc('agent.ask', { docId, agentId: a.id, request }).catch((e) => toast(e.message));
  const humans = space.humans.slice().sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  return (
    <aside className="left">
      <div className="space-head">
        <div className="space-mark">{initials(space.name)}</div>
        <div>
          <div className="space-name">{space.name}</div>
          <div className={`conn ${connection}`}>{connection === 'online' ? 'Connected' : 'Reconnecting…'}</div>
        </div>
      </div>

      <section>
        <h4>
          Docs
          <button
            className="link"
            onClick={async () => {
              const r = await client.rpc('doc.create', { title: 'Untitled doc' });
              setDocId(r.docId);
            }}
          >
            + New
          </button>
        </h4>
        {space.docs.map((d) => (
          <div key={d.id} className={`row doc-row ${d.id === docId ? 'on' : ''}`} onClick={() => setDocId(d.id)} role="button">
            <span className="doc-icon">▤</span>
            <span className="doc-name">{d.title || 'Untitled'}</span>
            {space.docs.length > 1 && (
              <button
                className="doc-del"
                title="Delete doc"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete “${d.title || 'Untitled'}” for everyone? This can't be undone.`))
                    client.rpc('doc.remove', { docId: d.id }).then(() => d.id === docId && setDocId(space.docs.find((x) => x.id !== d.id).id), (er) => toast(er.message));
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </section>

      <section>
        <h4>
          Agents
          <button className="link" onClick={() => setAdding(true)}>
            + Add
          </button>
        </h4>
        {space.agents.map((a) => (
          <div key={a.id} className="agent-row">
            <span className={`avatar agent st-${a.status}`} style={{ '--c': a.color }}>
              {initials(a.name)}
            </span>
            <div className="agent-main">
              <div className="agent-name">
                {a.name}
                {a.pending > 0 && <span className="pending">{a.pending}</span>}
              </div>
              <div className={`agent-status st-${a.status}`}>
                <i className="dot" />
                {STATUS_TEXT[a.status]}
                {a.detail && ['thinking', 'working', 'error'].includes(a.status) ? ` · ${a.detail}` : ''}
                {!a.online && a.lastSeen ? ` · ${ago(a.lastSeen, now)}` : ''}
              </div>
              <div className="agent-runtime">
                {a.host === 'external' ? 'external' : `this computer · ${a.runtime}`}
                {a.quarantine && <span className="tag" title="Quarantined reader: the model that reads docs has no tools">quarantined</span>}
                {a.scope === 'space' && <span className="tag warn" title="May act anywhere in the space, not just where it was asked">space-wide</span>}
              </div>
            </div>
            <div className="agent-actions">
              <button className="link" title="Ask this agent to review the open doc" onClick={() => ask(a, 'please review this doc in your specialty.')}>
                Review
              </button>
              <button className="link" title="Settings" onClick={() => setSettings(a)}>
                ⋯
              </button>
            </div>
          </div>
        ))}
        {space.agents.length > 1 && (
          <button className="btn ghost full" onClick={() => ask({ id: '*' }, 'please each review this doc in your specialty. Coordinate: one agent per block.')}>
            ✦ Ask every agent to review
          </button>
        )}
      </section>

      <section>
        <h4>People</h4>
        {humans.map((h) => (
          <div key={h.id} className="person-row">
            <span className={`avatar human ${h.online ? '' : 'off'}`} style={{ '--c': h.color }}>
              {initials(h.name)}
            </span>
            <span>
              {h.name}
              {h.id === me.id ? ' (you)' : ''}
            </span>
            <span className="muted small">{h.online ? 'here' : ago(h.lastSeen, now)}</span>
          </div>
        ))}
      </section>

      <section className="instructions">
        <h4>Space instructions</h4>
        <textarea
          rows={6}
          value={instr ?? space.instructions}
          onChange={(e) => setInstr(e.target.value)}
          onBlur={() => {
            if (instr !== null && instr !== space.instructions) client.rpc('space.instructions', { text: instr }).catch((e) => toast(e.message));
            setInstr(null);
          }}
          placeholder="Context every agent reads before acting: goals, audience, tone, rules."
        />
      </section>

      {adding && <AddAgent client={client} space={space} onClose={() => setAdding(false)} toast={toast} />}
      {settings && <AgentSettings client={client} space={space} agent={space.agents.find((a) => a.id === settings.id) || settings} onClose={() => setSettings(null)} toast={toast} />}
    </aside>
  );
}
