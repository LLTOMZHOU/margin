# Connect agents

Every agent is a member of the space with a name people can @mention. Two ways to run one.

## Hosted by a computer (recommended)

```bash
margin agents add Codex --runtime codex --about "Careful line editor"
```
(or in the app: sidebar → Agents → **+ Add**). Any `margin computer` connected to that hub picks it up
within seconds and shows it online. `margin serve` starts one for its own hub; for Cloudflare run
`margin computer --name <hub>`, and for a VPS `margin computer --server <url> --secret-file computer.json`.
If the runtime's CLI isn't installed or signed in on that machine, the computer doesn't host the agent
and `margin agents list` shows it offline with the reason.

When someone @mentions the agent, the hub sends a wake hint with no content; the computer runs the
agent headless in its own folder and the agent pulls what it needs from its inbox.

| Runtime | What runs | Needs on that machine |
| --- | --- | --- |
| `codex` | `codex exec` with only the Margin MCP tools, in a sandbox that can't read the user's files or reach the network | Codex CLI installed and signed in (`codex login`) |
| `claude-code` | `claude -p` with no built-in tools and only the Margin MCP server | Claude Code installed and signed in |
| `claude-api` | Claude Opus 5.5 with Margin tools | `ANTHROPIC_API_KEY` in the computer's environment |
| `sim` | rule-based demo agents | nothing |

Safety settings (flags on `agents add`, or sidebar → agent → ⋯):
- **Scope**: by default an agent may act only where the request that woke it points (that thread, that
  passage); the hub refuses anything else. `--space-wide` lets it act anywhere: only for agents the user fully trusts.
- **`--quarantine`**: the model that reads docs gets no tools at all and answers in a fixed form; plain
  code applies it. Recommend it for agents that read docs written by people outside the team.

Model overrides in the computer's environment: `MARGIN_CODEX_MODEL`, `MARGIN_CLAUDE_MODEL`, `MARGIN_MODEL` (claude-api).

## External (any agent, anywhere)

```bash
margin agents add Helper --runtime external     # writes its token to ~/.margin/tokens/helper.token (mode 600)
```
On the machine that runs it:
```bash
margin login --server <hub-url> --profile helper < helper.token     # or paste at the hidden prompt
MARGIN_PROFILE=helper margin bridge --runtime codex                 # keeps it online and wakes it
```
Or let an interactive session be the agent through MCP:
```bash
claude mcp add margin -e MARGIN_PROFILE=helper -- margin mcp
codex mcp add margin --env MARGIN_PROFILE=helper -- margin mcp
```
Then tell that session to use the `margin-agent` skill.
