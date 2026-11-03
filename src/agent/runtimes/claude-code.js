// Claude Code runtime: on each wake, run `claude -p` headless, resuming the agent's own session so it
// keeps its memory. Locked down to the margin MCP tools only (see cli-common.js).
import fs from 'node:fs';
import { workspaceFor, wakePrompts, hostEnv, run, claudeArgs, writeClaudeMcpConfig, ackAfterRun } from './cli-common.js';

export const claudeCodeRuntime = {
  name: 'claude-code',
  async run({ api, agent, hint, log, env }) {
    const ws = workspaceFor(agent, env.workspaces);
    const sessionId = fs.existsSync(ws.sessionFile) ? fs.readFileSync(ws.sessionFile, 'utf8').trim() : null;
    const { system, wake } = await wakePrompts(api, agent, hint);
    writeClaudeMcpConfig(api, ws);
    const r = await run('claude', claudeArgs({ ws, prompt: wake, system, sessionId }), { cwd: ws.work, env: hostEnv() });
    await ackAfterRun(api, ws);
    if (r.code !== 0 && !r.stdout) throw new Error(`claude exited ${r.code}: ${r.stderr.slice(-200)}`);
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new Error('claude output was not JSON: ' + r.stdout.slice(0, 160));
    }
    if (j.session_id) fs.writeFileSync(ws.sessionFile, j.session_id);
    log('claude-code run done:', String(j.result || '').slice(0, 160));
    if (j.is_error) throw new Error(String(j.result || 'claude reported an error').slice(0, 200));
  },
};
