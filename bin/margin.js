#!/usr/bin/env node
// margin — the agent's command line, and the bridge that connects a local agent to a hub.
//
//   margin login --server http://localhost:4321 --profile editor   (token on stdin)
//   margin inbox check            next batch; the following check acknowledges it
//   margin doc read <doc>         blocks with ids, open threads, leases
//   margin thread read <doc> <thread>
//   margin thread reply <doc> <thread> [--seen <msg>] [--key <k>]  <<< text
//   margin comment <doc> <block> --quote "exact words"            <<< text
//   margin propose edit <doc> <block>                              <<< new text (base = the text you last read)
//   margin propose insert <doc> [--after <block>] [--type p]       <<< text (blank line = new block)
//   margin propose delete <doc> <block>
//   margin lease claim <doc> <block>... | margin lease release <doc>
//   margin status <online|thinking|working|error|offline> [detail]
//   margin bridge --runtime sim|codex|claude-code|claude-api [--quarantine]  keep this agent online and wake it
//   margin computer --server <url> --secret <s>                    host every local agent of a hub
//
// Hosting (your machine, your VPS, or your Cloudflare account — never ours):
//   margin serve [--host 0.0.0.0] [--port 4321] [--public]         run a hub + this machine's computer
//     first run: --seed demo (a sample doc + 4 offline agents, default) | --seed welcome [--space "Team"]
//   margin serve --background | margin stop                        same, detached (logs in ~/.margin/serve.log)
//   margin deploy cloudflare [--name margin-hub] [--space "Team"]  deploy a hub to your Cloudflare account
//   margin undeploy cloudflare [--name margin-hub]                 delete it and its data again
//   margin invite [--name margin-hub]                              print the invite link and computer command
//   margin skills install [--for claude|codex|all]                 give your agents the setup skills
//
// Managing a hub (this machine's hub by default; --name <deployment> or --server <url> --key-file <f>):
//   margin agents list
//   margin agents add <Name> --runtime codex|claude-code|claude-api|sim|external [--about "role"] [--quarantine] [--space-wide]
//   margin agents remove <Name>
//   margin mcp                                                     run the MCP server (MARGIN_PROFILE picks the agent)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { AgentClient } from '../src/agent/client.js';
import { Bridge } from '../src/agent/bridge.js';
import { simRuntime } from '../src/agent/runtimes/sim.js';
import { claudeApiRuntime } from '../src/agent/runtimes/claude-api.js';
import { claudeCodeRuntime } from '../src/agent/runtimes/claude-code.js';
import { codexRuntime } from '../src/agent/runtimes/codex.js';
import { quarantinedRuntime } from '../src/agent/runtimes/quarantine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIMES = { sim: simRuntime, 'claude-api': claudeApiRuntime, 'claude-code': claudeCodeRuntime, codex: codexRuntime };
const HOME = process.env.MARGIN_HOME || path.join(os.homedir(), '.margin');

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJSON = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });
};

function profileName(flags) {
  return flags.profile || process.env.MARGIN_PROFILE || 'default';
}

function credentials(flags) {
  if (process.env.MARGIN_TOKEN && process.env.MARGIN_SERVER) return { server: process.env.MARGIN_SERVER, token: process.env.MARGIN_TOKEN };
  const p = readJSON(path.join(HOME, 'profiles.json'), {})[profileName(flags)];
  if (!p) die(`No credentials. Run \`margin login --server <url> --profile ${profileName(flags)}\` with the agent token on stdin, or set MARGIN_SERVER and MARGIN_TOKEN.`);
  return p;
}

function stateFile(flags) {
  const dir = process.env.MARGIN_STATE_DIR || path.join(HOME, 'state', profileName(flags));
  return path.join(dir, 'cli-state.json');
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function stdinText(flags) {
  if (typeof flags.text === 'string') return flags.text;
  if (process.stdin.isTTY) die('Provide text on stdin (heredoc) or with --text.');
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.replace(/\n$/, '');
}

// Read a secret from the terminal without echoing it.
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let v = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(v);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') v = v.slice(0, -1);
        else v += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function print(o) {
  if (process.env.MARGIN_JSON || globalThis.__json) return console.log(JSON.stringify(o, null, 2));
  console.log(o.text);
  if (o.next?.text) console.log(`Next: ${o.next.text}`);
  if (!o.ok) process.exitCode = 2;
}

// Remember what the agent read, so `propose edit` can send it as base_text by default.
function remember(flags, docId, blocks) {
  const f = stateFile(flags);
  const st = readJSON(f, {});
  st.lastRead = st.lastRead || {};
  st.lastRead[docId] = Object.fromEntries(blocks.map((b) => [b.id, b.text]));
  writeJSON(f, st);
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  globalThis.__json = !!flags.json;
  const [cmd, sub, ...rest] = pos;

  if (!cmd || cmd === 'help' || flags.help) {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  if (cmd === 'login') {
    if (!flags.server) die('margin login --server <url> [--profile name]   (token on stdin)');
    const token = (typeof flags.token === 'string' ? flags.token : process.stdin.isTTY ? await promptHidden('Paste the agent token: ') : (await stdinText({})).split('\n')[0]).trim();
    const api = new AgentClient({ server: flags.server, token });
    const me = await api.whoami();
    if (!me.ok) die(`Login failed: ${me.text}`);
    const f = path.join(HOME, 'profiles.json');
    const all = readJSON(f, {});
    all[profileName(flags)] = { server: flags.server, token };
    writeJSON(f, all);
    console.log(`${me.text}\nSaved profile “${profileName(flags)}”. Use it with MARGIN_PROFILE=${profileName(flags)}.`);
    return;
  }

  if (cmd === 'computer') return computer(flags);
  if (cmd === 'serve') return flags.background ? serveBackground(flags) : serve(flags);
  if (cmd === 'stop') return stopServe();
  if (cmd === 'deploy') return deploy(sub, flags);
  if (cmd === 'undeploy') return undeploy(sub, flags);
  if (cmd === 'invite') return invite(flags);
  if (cmd === 'skills') return skills(sub, flags);
  if (cmd === 'agents') return agents(sub, rest, flags);
  if (cmd === 'mcp') return import('../mcp/server.js');

  const creds = credentials(flags);
  const api = new AgentClient(creds);

  switch (cmd) {
    case 'whoami':
      return print(await api.whoami());
    case 'manual':
      return print(await api.manual());
    case 'docs':
      return print(await api.docs());
    case 'inbox': {
      // Receiving a batch is reading it: this check acknowledges the batch from the last check.
      const f = stateFile(flags);
      const st = readJSON(f, {});
      const r = await api.inbox(flags.peek ? undefined : st.cursor);
      if (r.ok && !flags.peek) writeJSON(f, { ...st, cursor: r.data.cursor });
      return print(r);
    }
    case 'doc': {
      if (sub !== 'read' || !rest[0]) die('margin doc read <doc>');
      const r = await api.doc(rest[0]);
      if (r.ok) remember(flags, rest[0], r.data.blocks);
      return print(r);
    }
    case 'thread': {
      const [docId, threadId] = rest;
      if (!docId || !threadId) die('margin thread read|reply <doc> <thread>');
      if (sub === 'read') {
        const r = await api.thread(docId, threadId);
        if (r.ok && r.data.thread.blockId) {
          const st = readJSON(stateFile(flags), {});
          remember(flags, docId, [...Object.entries(st.lastRead?.[docId] || {}).map(([id, text]) => ({ id, text })), { id: r.data.thread.blockId, text: r.data.blockText }]);
        }
        return print(r);
      }
      if (sub === 'reply') {
        const text = await stdinText(flags);
        return print(await api.reply(docId, threadId, { text, seen_through: flags.seen, idempotency_key: flags.key, hop: flags.hop }));
      }
      return die('margin thread read|reply <doc> <thread>');
    }
    case 'comment': {
      const [docId, blockId] = [sub, rest[0]];
      if (!docId || !blockId) die('margin comment <doc> <block> --quote "exact words" <<< text');
      return print(await api.comment(docId, { block_id: blockId, quote: flags.quote, text: await stdinText(flags) }));
    }
    case 'propose': {
      const docId = rest[0];
      if (!docId) die('margin propose edit|insert|delete <doc> ...');
      if (sub === 'edit') {
        const blockId = rest[1];
        if (!blockId) die('margin propose edit <doc> <block> <<< new text');
        let base = typeof flags.base === 'string' ? flags.base : undefined;
        if (base === undefined) base = readJSON(stateFile(flags), {}).lastRead?.[docId]?.[blockId];
        if (base === undefined) die(`Read the doc first (margin doc read ${docId}) so the hub knows which version you edited, or pass --base.`);
        return print(await api.propose(docId, { kind: 'edit', block_id: blockId, base_text: base, text: await stdinText(flags), type: flags.type, rationale: flags.why }));
      }
      if (sub === 'insert') {
        const text = await stdinText(flags);
        const blocks = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => {
          const m = t.match(/^(#{1,3})\s+(.*)$/s);
          if (m) return { type: 'h' + m[1].length, text: m[2] };
          if (/^[-*]\s+/.test(t)) return { type: 'li', text: t.replace(/^[-*]\s+/, '') };
          return { type: flags.type || 'p', text: t };
        });
        return print(await api.propose(docId, { kind: 'insert', after_block_id: flags.after || null, blocks, rationale: flags.why }));
      }
      if (sub === 'delete') return print(await api.propose(docId, { kind: 'delete', block_id: rest[1], rationale: flags.why }));
      return die('margin propose edit|insert|delete <doc> ...');
    }
    case 'lease': {
      if (sub === 'claim') return print(await api.lease(rest[0], rest.slice(1), flags.ttl ? Number(flags.ttl) * 1000 : undefined));
      if (sub === 'release') return print(await api.release(rest[0]));
      return die('margin lease claim <doc> <block>... | margin lease release <doc>');
    }
    case 'status':
      return print(await api.status(sub, rest.join(' ')));
    case 'bridge': {
      const me = await api.whoami();
      if (!me.ok) die(me.text);
      const runtimeName = flags.runtime || 'sim';
      if (!RUNTIMES[runtimeName]) die(`Unknown runtime ${runtimeName}. One of: ${Object.keys(RUNTIMES).join(', ')}`);
      const quarantined = !!flags.quarantine || !!me.data.agent.quarantine;
      const runtime = quarantined ? quarantinedRuntime(runtimeName) : RUNTIMES[runtimeName];
      const workspaces = flags.workspaces || path.join(HOME, 'workspaces');
      new Bridge({ ...creds, agent: me.data.agent, runtime, env: { workspaces } }).start();
      console.log(`Bridge up: @${me.data.agent.name} on runtime ${runtimeName}${quarantined ? ' (quarantined reader)' : ''}. Waiting for wake hints… (Ctrl+C to stop)`);
      return;
    }
    default:
      die(`Unknown command ${cmd}. Run margin help.`);
  }
}

// Host every local-computer agent of a hub (what `npm run dev` starts next to the server).
function computer(flags) {
  if (!flags.server || !flags.secret) die('margin computer --server <url> --secret <secret>');
  const workspaces = flags.workspaces || path.join(path.resolve(here, '..'), 'data', 'workspaces');
  const bridges = new Map();
  const log = (...a) => console.log('[computer]', ...a);
  const connect = () => {
    const ws = new WebSocket(flags.server.replace(/^http/, 'ws') + '/api/computer/stream?secret=' + encodeURIComponent(flags.secret));
    ws.on('open', () => log('connected to', flags.server));
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'host') {
        const old = bridges.get(m.agent.id);
        bridges.delete(m.agent.id);
        await old?.stop();
        const runtime = m.agent.quarantine ? quarantinedRuntime(m.agent.runtime) : RUNTIMES[m.agent.runtime] || simRuntime;
        const b = new Bridge({ server: flags.server, token: m.token, agent: m.agent, runtime, log: (...a) => console.log('[computer]', ...a), env: { workspaces } }).start();
        bridges.set(m.agent.id, b);
        log(`hosting @${m.agent.name} (${m.agent.runtime}${m.agent.quarantine ? ', quarantined' : ''}, scope ${m.agent.scope})`);
      }
      if (m.type === 'unhost') {
        const old = bridges.get(m.agentId);
        bridges.delete(m.agentId);
        await old?.stop();
      }
    });
    ws.on('close', () => {
      for (const b of bridges.values()) b.stop();
      bridges.clear();
      setTimeout(connect, 1500);
    });
    ws.on('error', () => {});
  };
  connect();
  // Stopping the computer stops its agents cleanly: each reports offline before the process exits.
  const shutdown = async () => {
    await Promise.race([Promise.all([...bridges.values()].map((b) => b.stop())), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const ROOT = path.resolve(here, '..');
const genSecret = () => crypto.randomBytes(18).toString('base64url');

function ensureBuilt() {
  if (fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) return;
  console.log('Building the web app…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('Build failed.');
}

// Run a hub on this machine (laptop or VPS) plus a computer that hosts its local agents.
async function serve(flags) {
  ensureBuilt();
  const host = flags.host || (flags.public ? '0.0.0.0' : '127.0.0.1');
  const port = Number(flags.port || process.env.PORT || 4321);
  const dataDir = path.resolve(flags.data || process.env.MARGIN_DATA || path.join(HOME, 'data'));
  // Anything reachable beyond this machine gets an access key, generated once and kept with the data.
  let accessKey = typeof flags['access-key'] === 'string' ? flags['access-key'] : process.env.MARGIN_ACCESS_KEY || '';
  if (typeof flags['access-key-file'] === 'string') accessKey = fs.readFileSync(flags['access-key-file'], 'utf8').trim();
  if (!accessKey && host !== '127.0.0.1' && host !== 'localhost') {
    const f = path.join(dataDir, 'access-key');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, genSecret(), { mode: 0o600 });
    accessKey = fs.readFileSync(f, 'utf8').trim();
  }
  if (typeof flags.seed === 'string') process.env.MARGIN_SEED = flags.seed; // first run only: demo | welcome
  if (typeof flags.space === 'string') process.env.MARGIN_SPACE_NAME = flags.space;
  const { startServer } = await import('../server/index.js');
  const srv = await startServer({ port, host, dataDir, accessKey, quiet: !flags.verbose });
  const local = `http://localhost:${srv.port}`;
  let child = null;
  if (!flags['no-computer']) {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'computer', '--server', local, '--secret', srv.computerSecret, '--workspaces', path.join(dataDir, 'workspaces')], { stdio: 'inherit' });
  }
  const pub = flags.url || (host === '0.0.0.0' ? `http://<this-server>:${srv.port}` : local);
  console.log(`\n  Margin hub running.\n  Open:    ${local}${accessKey ? `/?key=${accessKey}` : ''}`);
  if (accessKey) console.log(`  Invite:  ${pub}/?key=${accessKey}`);
  console.log(`  Agents on another machine: margin computer --server ${pub} --secret ${srv.computerSecret}\n`);
  const stop = async () => {
    child?.kill();
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// `serve` detached from the terminal, so an agent (or you) can start it and carry on.
async function serveBackground(flags) {
  const pidFile = path.join(HOME, 'serve.pid');
  const old = Number(readJSON(pidFile, 0));
  if (old && alive(old)) die(`A hub is already running (pid ${old}). Stop it with: margin stop`);
  const logFile = path.join(HOME, 'serve.log');
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(logFile, 'w');
  const args = process.argv.slice(2).filter((a) => a !== '--background');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  const port = Number(flags.port || process.env.PORT || 4321);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const log = fs.readFileSync(logFile, 'utf8');
    if (log.includes('Margin hub running')) {
      console.log(log.trim().split('\n').filter((l) => !/^\[computer\]/.test(l)).join('\n'));
      console.log(`\n  Running in the background (pid ${child.pid}). Logs: ${logFile}\n  Stop it with: margin stop\n`);
      return;
    }
    if (!alive(child.pid)) break;
  }
  die(`The hub did not start on port ${port}. Last lines of ${logFile}:\n` + fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n'));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopServe() {
  const pidFile = path.join(HOME, 'serve.pid');
  const pid = Number(readJSON(pidFile, 0));
  if (!pid || !alive(pid)) {
    fs.rmSync(pidFile, { force: true });
    return console.log('No background hub is running.');
  }
  process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile, { force: true });
  console.log(`Stopped the hub (pid ${pid}).`);
}

function deploymentFile(name) {
  return path.join(HOME, 'deployments', name + '.json');
}

// Deploy a private hub into the user's own Cloudflare account (Workers + a SQLite Durable Object).
async function deploy(target, flags) {
  if (target !== 'cloudflare') die('margin deploy cloudflare [--name margin-hub] [--space "Team space"]');
  const name = String(flags.name || 'margin-hub');
  if (!/^[a-z0-9-]{1,54}$/.test(name)) die('--name must be lowercase letters, digits and dashes.');
  ensureBuilt();
  // wrangler writes caches next to its config, and an installed package may be read-only, so the config
  // lives in ~/.margin/cloudflare/<name> and points back at the code and the built app.
  const work = path.join(HOME, 'cloudflare', name);
  fs.mkdirSync(work, { recursive: true });
  const config = path.join(work, 'wrangler.json');
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        name,
        main: path.join(ROOT, 'cloudflare', 'worker.js'),
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: path.join(ROOT, 'dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/ws'] },
        durable_objects: { bindings: [{ name: 'HUB', class_name: 'MarginHub' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MarginHub'] }],
        observability: { enabled: true },
      },
      null,
      2,
    ),
  );
  const localWrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const wrangler = (args) =>
    fs.existsSync(localWrangler)
      ? spawnSync(process.execPath, [localWrangler, ...args], { cwd: work, encoding: 'utf8' })
      : spawnSync('npx', ['-y', 'wrangler@4', ...args], { cwd: work, encoding: 'utf8' });
  const who = wrangler(['whoami']);
  if (who.error) die(`Could not run wrangler: ${who.error.message}`);
  if (/not authenticated|You are not/i.test(who.stdout + who.stderr))
    die('Not signed in to Cloudflare. Run `npx wrangler login` (it opens your browser), then run this again.');
  const f = deploymentFile(name);
  const prev = readJSON(f, null);
  const secrets = prev?.secrets || { MARGIN_ACCESS_KEY: genSecret(), MARGIN_COMPUTER_SECRET: genSecret() };
  const tmp = path.join(os.tmpdir(), `margin-secrets-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  const args = ['deploy', '--config', config, '--secrets-file', tmp, '--var', 'MARGIN_SEED:welcome', '--var', `MARGIN_SPACE_NAME:${flags.space || 'Our space'}`];
  if (flags['dry-run']) args.push('--dry-run', '--outdir', path.join(work, 'bundle'));
  console.log(`${flags['dry-run'] ? 'Building (dry run)' : 'Deploying'} ${name} ${flags['dry-run'] ? 'for' : 'to'} your Cloudflare account…`);
  const r = wrangler(args);
  fs.rmSync(tmp, { force: true });
  process.stdout.write(r.stdout);
  if (r.status !== 0) die(r.stderr || 'wrangler deploy failed');
  if (flags['dry-run']) return console.log('Dry run OK: nothing was uploaded.');
  const url = (r.stdout.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0] || prev?.url;
  if (!url) die('Deployed, but could not read the URL from wrangler output. Pass it later with: margin invite --name ' + name);
  writeJSON(f, { name, url, secrets, deployedAt: new Date().toISOString() });
  return invite({ name });
}

// Remove a Cloudflare hub and everything it stored (its Durable Object goes with the Worker).
function undeploy(target, flags) {
  if (target !== 'cloudflare') die('margin undeploy cloudflare [--name margin-hub]');
  const name = String(flags.name || 'margin-hub');
  const work = path.join(HOME, 'cloudflare', name);
  fs.mkdirSync(work, { recursive: true });
  const localWrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = ['delete', '--name', name];
  const r = fs.existsSync(localWrangler)
    ? spawnSync(process.execPath, [localWrangler, ...args], { cwd: work, input: 'y\n', encoding: 'utf8' })
    : spawnSync('npx', ['-y', 'wrangler@4', ...args], { cwd: work, input: 'y\n', encoding: 'utf8' });
  process.stdout.write(r.stdout);
  if (r.status !== 0) die(r.stderr || 'wrangler delete failed');
  fs.rmSync(deploymentFile(name), { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Removed ${name} and its data from your Cloudflare account, and its keys from this machine.`);
}

function invite(flags) {
  const name = String(flags.name || 'margin-hub');
  const d = readJSON(deploymentFile(name), null);
  if (!d) die(`No deployment called ${name} on this machine.`);
  console.log(`\n  Hub:      ${d.url}\n  Invite:   ${d.url}/?key=${d.secrets.MARGIN_ACCESS_KEY}   (share only with people you trust)`);
  console.log(`  Host this hub's agents on this machine:\n            margin computer --server ${d.url} --secret ${d.secrets.MARGIN_COMPUTER_SECRET}\n`);
}

// Which hub a management command talks to, and with which access key.
function hubTarget(flags) {
  if (typeof flags.server === 'string') {
    const key = typeof flags['key-file'] === 'string' ? fs.readFileSync(flags['key-file'], 'utf8').trim() : process.env.MARGIN_ACCESS_KEY || '';
    return { server: flags.server.replace(/\/$/, ''), key };
  }
  if (typeof flags.name === 'string') {
    const d = readJSON(deploymentFile(flags.name), null);
    if (!d) die(`No deployment called ${flags.name} on this machine.`);
    return { server: d.url, key: d.secrets.MARGIN_ACCESS_KEY };
  }
  const keyFile = path.join(path.resolve(flags.data || process.env.MARGIN_DATA || path.join(HOME, 'data')), 'access-key');
  return { server: `http://localhost:${flags.port || 4321}`, key: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '' };
}

// Add, list and remove a hub's agents from the command line (the same thing the sidebar does).
async function agents(sub, rest, flags) {
  if (!['list', 'add', 'remove'].includes(sub)) die('margin agents list | add <Name> --runtime <runtime> [--about "role"] | remove <Name>');
  const { server, key } = hubTarget(flags);
  const health = await fetch(`${server}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) die(`No hub answers at ${server}. Start one with \`margin serve --background\`, or pass --name / --server.`);
  const spaces = await fetch(`${server}/api/spaces`, { headers: key ? { 'x-margin-key': key } : {} }).then((r) => r.json());
  if (!Array.isArray(spaces)) die('The hub refused the access key.');
  const space = typeof flags.space === 'string' ? spaces.find((s) => s.id === flags.space || s.name === flags.space) : spaces[0];
  if (!space) die(`No space ${flags.space}. Spaces: ${spaces.map((s) => s.name).join(', ')}`);
  const { HubClient } = await import('../src/shared/sync.js');
  const url = server.replace(/^http/, 'ws') + '/ws' + (key ? `?key=${encodeURIComponent(key)}` : '');
  const c = new HubClient({ url, WebSocketImpl: WebSocket, user: { id: 'margin-cli', name: 'Setup (CLI)' }, spaceId: space.id });
  const sp = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out joining the space')), 10000);
    c.spaceListeners.add((s) => (clearTimeout(t), resolve(s)));
  });
  const byName = (n) => sp.agents.find((a) => a.name.toLowerCase() === String(n || '').toLowerCase());
  try {
    if (sub === 'list') {
      if (!sp.agents.length) console.log(`No agents in “${sp.name}” yet. Add one: margin agents add Codex --runtime codex`);
      for (const a of sp.agents)
        console.log(`@${a.name.padEnd(16)} ${a.runtime.padEnd(12)} ${a.online ? 'online ' : 'offline'}  ${a.scope === 'space' ? 'space-wide' : 'only where asked'}${a.quarantine ? ', quarantined' : ''}`);
    } else if (sub === 'add') {
      const name = rest[0];
      if (!name) die('margin agents add <Name> --runtime codex|claude-code|claude-api|sim|external');
      const runtime = typeof flags.runtime === 'string' ? flags.runtime : 'sim';
      const r = await c.rpc('agent.create', { name, runtime, description: typeof flags.about === 'string' ? flags.about : '', scope: flags['space-wide'] ? 'space' : 'wake', quarantine: !!flags.quarantine });
      console.log(`Added @${name} (${runtime}) to “${sp.name}”.`);
      if (r.token) {
        // The token never goes to stdout, where it would land in an agent's transcript.
        const f = typeof flags['token-file'] === 'string' ? flags['token-file'] : path.join(HOME, 'tokens', `${name.toLowerCase()}.token`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, r.token + '\n', { mode: 0o600 });
        console.log(`Its token is in ${f} (mode 600, shown nowhere else). On the machine that runs it:\n  margin login --server ${server} --profile ${name.toLowerCase()} < ${f}\n  MARGIN_PROFILE=${name.toLowerCase()} margin bridge --runtime codex   # or claude-code, or: margin mcp`);
      } else console.log('Any `margin computer` connected to this hub picks it up within seconds; mention it in a doc to wake it.');
    } else {
      const a = byName(rest[0]);
      if (!a) die(`No agent @${rest[0]}.`);
      await c.rpc('agent.remove', { agentId: a.id });
      console.log(`Removed @${a.name}.`);
    }
  } finally {
    c.close();
  }
}

// Copy the bundled skills into Claude Code's and Codex's skill folders.
function skills(sub, flags) {
  if (sub !== 'install') die('margin skills install [--for claude|codex|all]');
  const which = flags.for || 'all';
  const targets = [];
  if (which === 'claude' || which === 'all') targets.push(path.join(os.homedir(), '.claude', 'skills'));
  if (which === 'codex' || which === 'all') targets.push(path.join(os.homedir(), '.agents', 'skills'));
  const src = path.join(ROOT, 'skills');
  for (const t of targets) {
    for (const s of fs.readdirSync(src)) {
      fs.cpSync(path.join(src, s), path.join(t, s), { recursive: true });
      console.log(`installed ${s} → ${path.join(t, s)}`);
    }
  }
}

main().catch((e) => die(e.stack || e.message));
