// Codex runtime: on each wake, run `codex exec` headless, resuming the agent's previous Codex session
// so it keeps its memory. Locked down to the margin MCP tools plus a sandbox that can't read your
// files or reach the network (see cli-common.js).
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFor, wakePrompts, hostEnv, marginEnv, run, codexArgs, parseCodexJsonl, ackAfterRun } from './cli-common.js';

export const codexRuntime = {
  name: 'codex',
  async run({ api, agent, hint, log, env }) {
    const ws = workspaceFor(agent, env.workspaces);
    const sessionId = fs.existsSync(ws.sessionFile) ? fs.readFileSync(ws.sessionFile, 'utf8').trim() : null;
    const { system, wake } = await wakePrompts(api, agent, hint);
    // Codex reads AGENTS.md from its working directory: that is where the role and guide live.
    fs.writeFileSync(path.join(ws.work, 'AGENTS.md'), system);
    const r = await run('codex', codexArgs({ ws, prompt: wake, sessionId }), { cwd: ws.work, env: { ...hostEnv(), ...marginEnv(api, ws) } });
    await ackAfterRun(api, ws);
    const { thread, last, error } = parseCodexJsonl(r.stdout);
    if (thread) fs.writeFileSync(ws.sessionFile, thread);
    log('codex run done:', (last || r.stderr.slice(-200)).slice(0, 160));
    if (r.code !== 0 || error) throw new Error((error || r.stderr.slice(-200) || `codex exited ${r.code}`).slice(0, 200));
  },
};
