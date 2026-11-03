---
name: margin-setup
description: Install Margin and set up a private hub (docs where many people and many AI agents write together) on the user's own machine, their VPS, or their Cloudflare account, then connect Codex / Claude Code agents to it. Use when the user wants to install, host, deploy, invite people to, connect agents to, or remove Margin.
---

# Set up Margin

Margin is an open-source toolkit, not a service: a **hub** (docs, comment threads, agent inboxes)
runs on something the user owns, and a **computer** process on their machine hosts their agents
(Codex, Claude Code, the Claude API) and wakes them when someone @mentions them in a doc.
Agents never write into docs directly: they propose edits, and people approve them.

Work through the steps in order. Ask the user only where a step says to ask. Tell them in one line
what you're doing as you go.

## 1. Check Node.js

```bash
node -v    # needs v20 or newer
```
If it's missing or older, stop and tell the user how to get it (https://nodejs.org, `brew install node`,
or `nvm install 22`). Don't install system software without their OK.

## 2. Install the CLI

```bash
npm install -g https://github.com/LLTOMZHOU/margin/releases/latest/download/margin-hub.tgz
margin help
```
If `npm install -g` fails with `EACCES`, install into the user's home instead and use the full path:
```bash
npm install -g --prefix ~/.local https://github.com/LLTOMZHOU/margin/releases/latest/download/margin-hub.tgz
~/.local/bin/margin help        # suggest adding ~/.local/bin to PATH
```
Then keep these instructions with the user's agents for next time (copies `margin-setup` and
`margin-agent` into `~/.claude/skills` and `~/.agents/skills`):
```bash
margin skills install
```

## 3. Ask one question: where should the hub live?

| Option | Good for | Cost | What the user does |
| --- | --- | --- | --- |
| **This machine** (default) | trying it, solo use, a team on one network | free | nothing |
| **Their Cloudflare account** | a team, always on, nothing to maintain | free tier is enough for small teams | signs in once with `npx wrangler login` |
| **Their VPS** | full control, own domain | the VPS | gives you a host you can `ssh` into |

If they don't mind, use **this machine** now; moving to Cloudflare later is one command.
For this machine, start a clean hub named for them (`--seed welcome --space "…"`) unless they only
want to look around, in which case the sample doc with demo agents (the default) is nicer.
Never host it on a service run by someone else: the point is that it's theirs.

Then follow the guide for their choice:
- This machine → [reference/local.md](reference/local.md)
- Cloudflare → [reference/cloudflare.md](reference/cloudflare.md)
- VPS → [reference/vps.md](reference/vps.md)

## 4. Add the user's agents

See which agent CLIs this machine has:
```bash
command -v codex; command -v claude
```
For each one that's installed, offer to add it (one line each, not a questionnaire):
```bash
margin agents add Codex  --runtime codex       --about "Careful line editor. Proposes small edits."
margin agents add Claude --runtime claude-code --about "Research partner. Checks claims, drafts sections."
margin agents list
```
They run on this machine through the computer started with the hub, signed in as the user already is.
If `agents add` warns that a CLI isn't signed in, tell the user the exact login command it printed;
`agents list` shows such an agent offline with the reason. "Online" means a computer is hosting it;
the real test is mentioning it in a doc and seeing it reply.
Every new hub also has four built-in demo agents (`@Editor`, `@Fact-Checker`, `@Skeptic`, `@Scribe`:
rule-based, no model), so there's always something to try even without Codex or Claude Code.
Details, runtimes and safety settings: [reference/agents.md](reference/agents.md).

## 5. Hand over

Tell the user, in this order:
1. the link to open (for a hub other people can reach, the invite link `…/?key=…`, and that anyone
   with it can get in, so share it only with people they trust);
2. "Select any sentence, comment, and type @Codex (or another agent) to ask it something";
3. how to stop it (`margin stop`, or `margin undeploy cloudflare`) and where the data lives.

## Removing Margin

- Local hub: `margin stop`, then delete `~/.margin` (all docs and keys).
- The skills: `margin skills remove` (before uninstalling the CLI).
- Cloudflare: `margin undeploy cloudflare --name <name>` deletes the Worker and its data, and the keys on this machine.
- The CLI: `npm uninstall -g margin-hub`.

## Safety rules

- Keys (`access key`, `computer secret`, `sk_agent_…` tokens) don't go in chat, commits or command
  arguments. Margin keeps them in files with mode 600; pass them with `--key-file`, stdin, or a hidden prompt.
- A hub reachable from the internet must have an access key. Margin makes one automatically for
  `--public` and for Cloudflare.
- Don't sign in to anything for the user. They run `npx wrangler login`, `codex login`, `ssh` setup themselves.
- Agents are locked down by default: woken agents get only the Margin tools (Claude Code: no built-in
  tools and none of the user's MCP servers; Codex: a sandbox with no file or network access), and the
  hub only lets an agent act where the request that woke it points. Leave agents at that scope unless
  the user fully trusts one; suggest `--quarantine` for agents that read docs from outside their team.
  Background: https://github.com/LLTOMZHOU/margin/blob/main/docs/SECURITY.md
