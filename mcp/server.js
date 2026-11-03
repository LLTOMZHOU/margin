#!/usr/bin/env node
// MCP server: lets an interactive agent (Claude Code, or any MCP client) join a Margin space.
// It holds the agent's wake-hint stream, so the agent shows Online while the session is open.
//
//   claude mcp add margin -e MARGIN_PROFILE=editor -- node /path/to/margin_project/mcp/server.js
//
// Credentials: MARGIN_SERVER + MARGIN_TOKEN, or a profile saved by `margin login`.
// MARGIN_CHANNEL=1 also pushes each wake into the session as a Claude Code channel event
// (start Claude Code with the channels flag for that to show up).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentClient } from '../src/agent/client.js';

const HOME = process.env.MARGIN_HOME || path.join(os.homedir(), '.margin');
function creds() {
  if (process.env.MARGIN_SERVER && process.env.MARGIN_TOKEN) return { server: process.env.MARGIN_SERVER, token: process.env.MARGIN_TOKEN };
  const all = JSON.parse(fs.readFileSync(path.join(HOME, 'profiles.json'), 'utf8'));
  const p = all[process.env.MARGIN_PROFILE || 'default'];
  if (!p) throw new Error('No Margin profile. Run `margin login` first or set MARGIN_SERVER and MARGIN_TOKEN.');
  return p;
}

const dbg = (m) => process.env.MARGIN_MCP_LOG && fs.appendFileSync(process.env.MARGIN_MCP_LOG, `${new Date().toISOString()} ${m}\n`);
dbg(`start pid=${process.pid} server=${process.env.MARGIN_SERVER || '(profile)'}`);
process.on('uncaughtException', (e) => {
  dbg('crash ' + e.stack);
  process.exit(1);
});
const c = creds();
const api = new AgentClient(c);
dbg('fetching manual');
const manualOutcome = await api.manual();
dbg(`manual ok=${manualOutcome.ok} state=${manualOutcome.state} ${manualOutcome.ok ? '' : manualOutcome.text}`);
const channel = process.env.MARGIN_CHANNEL === '1';
const server = new McpServer(
  { name: 'margin', version: '0.1.0' },
  { capabilities: channel ? { experimental: { 'claude/channel': {} } } : {}, instructions: manualOutcome.text },
);

// ---- wake stream
let waiters = [];
let lastWake = null;
function openStream() {
  const ws = new WebSocket(c.server.replace(/^http/, 'ws') + '/api/agent/stream', { headers: { authorization: 'Bearer ' + c.token } });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'wake') return;
    lastWake = m;
    waiters.forEach((w) => w(m));
    waiters = [];
    if (channel)
      server.server
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content: `Margin wake: ${m.pendingCount} event(s) waiting${m.target ? ` in ${m.target}` : ''}. Call inbox_check.`,
            meta: { target: m.target || '', pending: String(m.pendingCount) },
          },
        })
        .catch(() => {});
  });
  ws.on('close', (code) => code !== 4001 && setTimeout(openStream, 2000));
  ws.on('error', () => {});
}
openStream();

let cursor;
const text = (o) => ({ content: [{ type: 'text', text: o.text + (o.next?.text ? `\nNext: ${o.next.text}` : '') }], isError: !o.ok && !['interrupted', 'pending', 'empty'].includes(o.state) });

server.registerTool('inbox_check', { description: 'Get the next batch of inbox events. Calling it again acknowledges the previous batch.', inputSchema: {} }, async () => {
  const r = await api.inbox(cursor);
  if (r.ok) {
    cursor = r.data.cursor;
    // Lets the bridge acknowledge the last batch if the session ends without a final check.
    if (process.env.MARGIN_STATE_FILE) fs.writeFileSync(process.env.MARGIN_STATE_FILE, JSON.stringify({ cursor }), { mode: 0o600 });
  }
  return text(r);
});

server.registerTool(
  'wait_for_wake',
  { description: 'Block until something arrives in your inbox (or the timeout passes). Use it to stay in a work loop.', inputSchema: { timeout_seconds: z.number().int().min(1).max(600).optional() } },
  async ({ timeout_seconds = 120 }) => {
    const peek = await api.inbox(cursor);
    if (peek.data?.events?.length) return text({ ok: true, text: `${peek.data.events.length} event(s) waiting. Call inbox_check.` });
    const m = await Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(() => r(null), timeout_seconds * 1000))]);
    return text({ ok: true, text: m ? `Woken: ${m.pendingCount} event(s) waiting${m.target ? ` in ${m.target}` : ''}. Call inbox_check.` : 'Nothing arrived. Wait again or stop.' });
  },
);

server.registerTool('whoami', { description: 'Who you are in the space, and its instructions.', inputSchema: {} }, async () => {
  const r = await api.whoami();
  return text({ ...r, text: `${r.text}\nSpace instructions:\n${r.data?.space?.instructions || '(none)'}` });
});
server.registerTool('list_docs', { description: 'List the docs in the space.', inputSchema: {} }, async () => text(await api.docs()));
server.registerTool('read_doc', { description: 'Read a doc: blocks with ids, open threads, leases, your proposals.', inputSchema: { doc_id: z.string() } }, async ({ doc_id }) =>
  text(await api.doc(doc_id)),
);
server.registerTool('read_thread', { description: 'Read a thread and the block it is anchored to.', inputSchema: { doc_id: z.string(), thread_id: z.string() } }, async ({ doc_id, thread_id }) =>
  text(await api.thread(doc_id, thread_id)),
);
server.registerTool(
  'reply_in_thread',
  {
    description: 'Reply in a thread. Pass seen_through (last message id you read). If the reply comes back held, read what you missed, then resend with idempotency_key or write a new reply.',
    inputSchema: { doc_id: z.string(), thread_id: z.string(), text: z.string(), seen_through: z.string().optional(), idempotency_key: z.string().optional() },
  },
  async (a) => text(await api.reply(a.doc_id, a.thread_id, { text: a.text, seen_through: a.seen_through, idempotency_key: a.idempotency_key })),
);
server.registerTool(
  'propose_edit',
  {
    description: 'Propose new full text for one block. base_text = the block text you read; the hub merges with concurrent human edits.',
    inputSchema: { doc_id: z.string(), block_id: z.string(), base_text: z.string(), text: z.string(), rationale: z.string().optional() },
  },
  async (a) => text(await api.propose(a.doc_id, { kind: 'edit', block_id: a.block_id, base_text: a.base_text, text: a.text, rationale: a.rationale })),
);
server.registerTool(
  'propose_insert',
  {
    description: 'Propose new blocks after a block (omit after_block_id for the top).',
    inputSchema: {
      doc_id: z.string(),
      after_block_id: z.string().optional(),
      blocks: z.array(z.object({ type: z.enum(['h1', 'h2', 'h3', 'p', 'li', 'quote', 'code']), text: z.string() })),
      rationale: z.string().optional(),
    },
  },
  async (a) => text(await api.propose(a.doc_id, { kind: 'insert', after_block_id: a.after_block_id || null, blocks: a.blocks, rationale: a.rationale })),
);
server.registerTool('propose_delete', { description: 'Propose deleting one block.', inputSchema: { doc_id: z.string(), block_id: z.string(), rationale: z.string().optional() } }, async (a) =>
  text(await api.propose(a.doc_id, { kind: 'delete', block_id: a.block_id, rationale: a.rationale })),
);
server.registerTool(
  'add_comment',
  { description: 'Open a comment thread anchored to exact words in a block.', inputSchema: { doc_id: z.string(), block_id: z.string(), quote: z.string(), text: z.string() } },
  async (a) => text(await api.comment(a.doc_id, { block_id: a.block_id, quote: a.quote, text: a.text })),
);
server.registerTool('claim_blocks', { description: 'Lease blocks so other agents do not edit them meanwhile.', inputSchema: { doc_id: z.string(), block_ids: z.array(z.string()) } }, async (a) =>
  text(await api.lease(a.doc_id, a.block_ids, 120_000)),
);
server.registerTool(
  'set_status',
  { description: 'Tell the humans what you are doing.', inputSchema: { status: z.enum(['online', 'thinking', 'working', 'error']), detail: z.string().max(200).optional() } },
  async (a) => text(await api.status(a.status, a.detail || '')),
);

await server.connect(new StdioServerTransport());
dbg('connected');
