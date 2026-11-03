# Margin: market analysis

_Researched 2026-11-01. Star counts come from the GitHub API on that date. Every claim has a link. Claims I could only find in third-party coverage say so, and claims I couldn't confirm at all are marked **unverified**._

## TL;DR

- **The gap is narrow but real.** In the last nine months, everyone added "agents in shared docs": ChatGPT Space/Pages (Sep 29, 2026), Claude artifacts with multiplayer editing and comments (Jul–Sep 2026), the Gemini agent in Docs comments (Oct 8, 2026), and Notion's External Agents API (May 13, 2026). None of them is **self-hostable**, and none gives a **human-approval policy plus a merge guarantee** for agent edits. Raft (raft.build) is the closest product in spirit. It is chat plus tasks, and files there are attachments with anchored comments rather than live co-edited documents. It is also source-available (FSL) and accepts no PRs.
- **First customers:** (1) AI-native builders and small startups already running fleets of Claude Code or Codex agents; (2) small research labs and technical-writing teams; (3) boutique consultancies and agencies, especially privacy-sensitive ones. Regulated enterprises are the long-term revenue segment, but they are not a 30-day segment.
- **Wedge:** _"The shared doc where everyone's own agents propose and humans approve, running on your own machine or Cloudflare account and set up by your agent in five minutes."_
- **Biggest risks:** incumbents (and Raft) closing the bring-your-own-agent gap; the cost of self-hosting; and prompt injection through shared docs into agents that run with local privileges.

---

## 1. Customer segments

**What the demand signal looks like.** Raft says that during its beta, more than 20,000 builders and teams used it, averaging four agents per human, with power users running over sixty ([TestingCatalog, Jul 16 2026](https://www.testingcatalog.com/raft-1-0-puts-ai-agents-in-team-mode/); company-reported). Claude Code users are filing GitHub issues for exactly what Margin does:
- inline comments on artifacts ([#86760](https://github.com/anthropics/claude-code/issues/86760))
- notifications for @mentions in comments ([#100904](https://github.com/anthropics/claude-code/issues/100904))
- exporting and importing threads with their anchors ([#87961](https://github.com/anthropics/claude-code/issues/87961))
- deleting comment threads ([#91701](https://github.com/anthropics/claude-code/issues/91701))

Those issue authors are a ready-made prospect list.

| # | Segment (who exactly) | Job-to-be-done | Does self-hosting matter? | What they use today | How painful is the gap? | How reachable? |
|---|---|---|---|---|---|---|
| **1** | **AI-native startups and solo founders running agent fleets.** 1–15 humans, 3–60 agents; CTO/founder-engineers on Claude Max or Codex plans | Co-write specs, PRDs, RFCs, launch docs and runbooks with several agents without anyone getting clobbered; review agent output where it lands | **Medium.** They care more about using their own subscriptions and keys, low cost and control than about compliance. Many already run local daemons (Raft Computer, OpenClaw) | Markdown in git plus PR review; Raft channels plus file attachments; Notion with the MCP server; Claude/ChatGPT artifacts | **High.** Agents overwrite each other's files, and with git-markdown nobody co-edits live. Existing doc tools pick one vendor's agent | **Very high:** X, HN, r/ClaudeAI, Claude Code issues, the [Raft Builder Program](https://raft.build/), [awesome-raft-build](https://github.com/raft-builders/awesome-raft-build), skills directories |
| **2** | **Small research labs.** A PI plus 3–20 students or postdocs; also industry research groups | Papers, grant proposals, related-work sections, lab notebooks; agents run literature passes and edits; the PI approves | **High.** Unpublished results, IRB or clinical data, and funder or university rules. Labs often have their own servers | Overleaf, Google Docs, ChatGPT/Claude used one person at a time and pasted back in | **Medium-high.** Pasting agent output into shared docs loses provenance. "Majority of online humans" approval fits co-authorship | **Medium:** academic X/Bluesky, lab Slacks, Yjs/CRDT researchers, university research-computing groups |
| **3** | **Boutique consultancies and agencies.** 5–50 people: dev shops, security and compliance consultancies, legal-tech or health-data advisors | Client deliverables (reports, SOWs, audits), with each client's agents and humans in an isolated workspace | **High.** Client NDAs; one hub per client is a selling point | Google Docs/Word plus a separate ChatGPT/Claude; Notion | **Medium-high.** No clean per-client isolation for agent access | **Medium:** LinkedIn, agency communities, Cloudflare/Vercel partner ecosystems |
| 4 | **Regulated or privacy-sensitive teams.** Legal, health, finance, government, EU data residency | Drafting with AI while keeping confidentiality and audit trails | **Critical.** In ILTA's 2026 survey of 500 law firms, 94% use or explore GenAI and 55% still cite confidentiality as a concern ([Laurel summary of ILTA](https://www.laurel.ai/blog/legal-ai-adoption-2026-ilta-survey)). Note that ChatGPT Space and Pages are not covered by its EU data-residency guarantee (third-party: [Android Headlines](https://www.androidheadlines.com/2026/09/openai-launches-chatgpt-space-collaborative-hub.html)) | Word/iManage, Copilot, legal AI vendors; in the EU public sector, La Suite Docs (Yjs + BlockNote) and openDesk ([OSOR 2026](https://interoperable-europe.ec.europa.eu/sites/default/files/inline-files/2026-france-osor-country-report_0.pdf), [Wikipedia: openDesk](https://en.wikipedia.org/wiki/OpenDesk)) | **High pain, low fit today.** They need SSO, audit export, retention and security review. "Agents on laptops" scares their CISOs | **Low:** procurement-driven with long cycles. Reach them through integrators later |
| 5 | **Open-source maintainers and communities** | RFCs and design docs where contributors bring their own agents | **Low.** The content is public; "free" matters more than "private" | GitHub issues, PRs and Discussions; HackMD/HedgeDoc | **Low-medium.** GitHub is good enough, and the async model already works | **High:** GitHub. Good for **distribution and credibility**, near-zero revenue |
| 6 | **Educators.** Instructors, TA teams, coding bootcamps | Students and agents co-writing, with approval as a teaching device | Medium (student data rules such as FERPA/GDPR) | Google Docs, Canvas LMS, ChatGPT Edu | Low-medium | Low: semester cycles and IT approval |
| 7 | **Enterprises with "bring your own agent" policies** | Let employees' sanctioned agents (Claude, Codex, Copilot) work in shared docs under governance | High | Microsoft 365 Copilot Pages, Google Workspace with the Gemini agent, Notion Enterprise with External Agents | Medium. Incumbents are shipping this inside suites the enterprise already owns | **Very low** for a solo OSS project |

**Ranking:** 1 > 2 > 3 > 4 > 5 > 7 > 6.

**Pick the first 2–3 customers from segments 1, 2 and 3.**
- **Segment 1** already runs local agents, already writes CLAUDE.md and skills, and can install Margin by prompting its own agent, which is exactly how Margin installs. The demo ("my Claude Code and my cofounder's Codex edited the same spec and nothing got lost") lands immediately. The weakness is that many of these people are happy in Raft or git-markdown. Margin has to be complementary, not a replacement.
- **Segment 2** has a genuine privacy reason to self-host, has co-authorship norms that map onto Margin's approval policies, and has long-lived documents. That makes it the best retention test.
- **Segment 3** is the first that will **pay**, for setup and support. "One hub per client on the client's own Cloudflare account" is a story a sales team can tell.
- Treat **segment 4** as design partners once segment 3 asks for audit export and SSO. Treat **segment 5** as a channel, not a customer.

---

## 2. Competitive landscape

Legend: ✅ yes · ◐ partial or limited · ❌ no.

| Product | Multi-human | Multi-agent | Bring-your-own-agent | Self-hostable | License / pricing | Notes and source |
|---|---|---|---|---|---|---|
| **Raft** (formerly Slock) | ✅ channels, threads, DMs | ✅ persistent agents claim tasks | ✅ local "Raft Computer" plus experimental External Agents (Claude Code, Hermes, others) | ◐ source available; "Private deployment" is listed under Enterprise "Coming soon" | FSL-1.1-ALv2 (converts to Apache 2.0 after 2 years). Free tier (30-day history); Pro $8.80/seat/mo annual, with an agent counting as 0.1 seat | Chat and tasks, not co-edited docs. Files are attachments with comments anchored to passages or lines. Release mirror, PRs auto-closed. [pricing](https://raft.build/pricing), [files docs](https://docs.raft.build/features/collaboration/files.md), [external agents](https://docs.raft.build/features/agents/external.md), [raft-source](https://github.com/botiverse/raft-source) (694★) |
| **Slack** (Slackbot, MCP server, agents) | ✅ | ✅ marketplace agents (Claude Tag, ChatGPT, Agentforce…) | ◐ via the MCP server, but only for Marketplace or internal apps | ❌ | Pro $7.25, Business+ $15 (annual); Slackbot is capped on Business+ (third-party: [superdupr](https://superdupr.com/blog/slack-pricing)) | MCP server and Real-time Search API went GA Feb 17, 2026 ([Slack changelog](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/)). Canvases are not merge-safe for agents. |
| **Notion** (Custom Agents, External Agents API) | ✅ | ✅ | ✅ External Agents API (alpha); Claude, Codex and Cursor work out of the box | ❌ | Plus $10, Business $20/seat; Custom Agents cost $10 per 1,000 credits ([pricing](https://www.notion.com/pricing)) | **The strongest bring-your-own-agent incumbent** ([release notes May 13 2026](https://www.notion.com/releases/2026-05-13), [TechCrunch](https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/)). Cloud only. |
| **Google Docs + Gemini agent** | ✅ | ✅ sub-agents and "coworker agents" with their own identity | ❌ Gemini only (Claude for Workspace is a sidebar beta, **unverified**) | ❌ | Workspace plans | Tag the agent in a comment; it suggests edits under its own name ([Google Cloud blog, Oct 2026](https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026)) |
| **Microsoft Loop / Copilot Pages** | ✅ | ◐ Copilot plus agents you can @mention | ❌ (Copilot Studio agents only) | ❌ | M365 Copilot licenses | "Multiplayer human-to-AI-to-human" since 2024 ([Microsoft](https://www.microsoft.com/en-us/copilot/blog/2024/09/16/microsoft-365-copilot-wave-2-pages-python-in-excel-and-agents/)). Agent work in Pages during 2026 is **unverified** |
| **ChatGPT Space / Pages / shared Projects** | ✅ real-time Pages; Projects are async | ✅ ChatGPT plus Dots agents | ❌ | ❌ | Pro, Business and Enterprise | Space launched Sep 29, 2026 and replaces Library ([OpenAI help](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt), [The Neuron](https://www.theneuron.ai/news/openai-devday-2026-chatgpt-is-becoming-an-ai-operating-system/)). Canvas was reportedly retired May 2026 (third-party, [ai-toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/canvas-sharing-how-to-share-chatgpt-canvas-creations)). **The most direct threat to the "UX" half of Margin.** |
| **Claude Projects / Artifacts / Docs** | ✅ multiplayer editing (Team/Enterprise), view/comment/edit roles | ◐ one Claude per user; Claude Tag in Slack | ❌ | ❌ | Team/Enterprise | Multiplayer artifacts launched Jul 13, 2026 ([ClaudeDevs on X](https://x.com/ClaudeDevs/status/2076789349145092230)); sharing reworked Sep 16, 2026 ([coeditapp](https://coeditapp.com/blog/claude-artifacts-public-sharing-and-multiplayer)). Users still ask for notifications and export (issues above). |
| **Claude Code / Codex / Cursor multi-agent** | ❌ (single developer) | ✅ Claude Code Agent Teams (experimental); Codex subagents GA Mar 2026; Cursor cloud agents | n/a (they *are* the agents) | local CLI | Subscriptions | They are the workers Margin hosts, not competitors ([Claude Code agent teams docs](https://code.claude.com/docs/en/agent-teams); Codex details are third-party, [danielvaughan](https://codex.danielvaughan.com/2026/04/09/codex-vs-claude-code-multi-agent/)). Risk: Anthropic or OpenAI adding a "team doc" surface. |
| **Linear agents** | ✅ | ✅ | ✅ Agent Interaction SDK (delegate, @mention) | ❌ | Linear plans | The "issues can only be *delegated* to agents, a human stays accountable" model is worth copying ([Linear](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)) |
| **Liveblocks** | ✅ | ✅ agents set presence and mutate storage server-side | ✅ (it's infrastructure) | ◐ Enterprise add-on | Free / Pro $25/mo / Team $500/mo; Apache-2.0 plus some AGPL parts ([pricing](https://liveblocks.io/pricing), [agentic editing docs](https://liveblocks.io/docs/products/sync/agentic-editing)) | Infrastructure that markets itself as "human-AI collaboration". It is a building block, not a product rival |
| **Tiptap AI Toolkit / Hocuspocus** | ✅ | ✅ server-side agent edits shown as tracked changes | ✅ "you keep your agent loop" | ✅ Hocuspocus (MIT, 2.6k★); AI and comments require the paid Platform or on-prem Enterprise | Editor MIT (38.9k★) | [AI Toolkit beta Jul 15 2026](https://tiptap.dev/blog/release-notes/ai-toolkit-now-in-beta). **A possible substrate for Margin's editor UI** |
| **AFFiNE** | ✅ | ◐ built-in AI (BYOK) | ❌ no external-agent protocol found | ✅ free up to 10 seats; $10/seat Team | Mixed MIT plus Enterprise backend; 74.1k★ | [repo](https://github.com/toeverything/AFFiNE), [self-hosted AI blog](https://affine.pro/blog/self-hosted-ai) |
| **AppFlowy** | ✅ | ◐ local AI via Ollama | ❌ | ✅ (server moving to open-core, per third-party [KDnuggets](https://www.kdnuggets.com/7-open-source-ai-tools-that-can-replace-paid-subscriptions)) | AGPL-3.0; 78.1k★ | [compare page](https://appflowy.com/compare/notion-vs-appflowy) |
| **Outline** | ✅ | ◐ any MCP agent can read, write, patch and comment | ✅ via its built-in MCP server and WebMCP | ✅ | BSL 1.1 (no "Document Service" use); 41.1k★ | MCP launched Feb 18, 2026, patch and comment tools added Apr 2026 ([changelog](https://www.getoutline.com/changelog/mcp)). **The closest self-hosted rival on agent access**, but agents write directly with no approval layer |
| **Docmost** | ✅ | ◐ | ◐ MCP and API are **paid** (Business/Enterprise) | ✅ | AGPL-3.0 plus EE; 22.2k★ | Gating MCP led to many community MCP forks ([docmost blog](https://docmost.com/blog/selfhosted-enterprise-wiki-ai/), [community MCP](https://github.com/Rahulk644/docmost-mcp)). **Lesson: don't paywall agent access** |
| **HedgeDoc** | ✅ | ❌ (no native agent features found, **unverified**) | ❌ | ✅ | AGPL-3.0; 7.5k★ | [repo](https://github.com/hedgedoc/hedgedoc) |
| **Etherpad** | ✅ | ❌ (**unverified**) | ❌ | ✅ | Apache-2.0; 18.6k★ | [repo](https://github.com/ether/etherpad) |
| **Mattermost** | ✅ chat | ✅ Agents plugin, multiple LLMs, MCP tools | ◐ LLM backends, not external coding agents | ✅ | MIT/AGPL plus source-available EE; 39.5k★ | "Sovereign AI" positioning ([docs](https://docs.mattermost.com/agents/docs/sovereign_ai)) |
| **Zulip** | ✅ chat | ◐ community ACP bridge (zulip-acp) | ◐ | ✅ | Apache-2.0; 26.2k★ | [zulip-acp](https://pkg.go.dev/github.com/kfet/zulip-acp@v0.4.0) |
| **Anytype** | ✅ (local-first P2P) | ◐ official local MCP server | ◐ | ✅ | Any Source Available License; 9.0k★ | [anytype-mcp](https://lobehub.com/mcp/anyproto-anytype-mcp) |
| **La Suite Docs** (FR/DE government) | ✅ | ❌ | ❌ | ✅ | MIT (**unverified**) | Built on Yjs and BlockNote; a possible channel into the EU public sector ([Wikipedia](https://en.wikipedia.org/wiki/Docs_(software))) |

**Takeaways:**
1. "Agents edit shared docs" is now **table stakes** at every incumbent.
2. Bring-your-own-agent is **solved in the cloud** by Notion and Slack through MCP and External Agents APIs.
3. Self-hosted tools (Outline, Docmost, Anytype) are adding **MCP write access with no approval, merge or lease semantics**.
4. Nobody combines all four of: **self-hosted, live CRDT doc, propose-then-approve with 3-way re-merge, and agents running on users' own machines.** That combination is the product.

### Agent-interop protocols: help or threat?

| Protocol | Status | Effect on Margin |
|---|---|---|
| **MCP** | Donated to the Linux Foundation's Agentic AI Foundation (AAIF) on Dec 9, 2025 ([Anthropic](https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/)) | **Helps adoption, erodes the moat.** Ship an MCP server so any agent can connect in one line. But MCP is also why Outline, Notion and Docmost became agent-writable. Bring-your-own-agent alone is not defensible; the approval and merge semantics are. |
| **ACP** (Agent Client Protocol) | Co-developed by Zed and JetBrains ([The Register](https://www.theregister.com/2025/10/07/jetbrains_acp_vs_code/), [JetBrains](https://www.jetbrains.com/acp/)); the registry reportedly lists about 42 agents (third-party, [morphllm](https://www.morphllm.com/agent-client-protocol)); [repo](https://github.com/agentclientprotocol/agent-client-protocol) 4.6k★ | **Strong help.** The local bridge can act as an ACP *client* and drive Claude Code, Codex, Gemini CLI and goose through a single adapter instead of N bespoke ones. zulip-acp shows the pattern. |
| **A2A** | AAIF since Aug 2026; LF reports 150+ supporting organizations ([LF press](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/)); [repo](https://github.com/a2aproject/A2A) 26.4k★ | **Neutral for now.** It is an enterprise agent-to-agent mesh. Expose an A2A Agent Card later for segment 7. Neither Codex nor Claude Code implements it natively (third-party, Apr 2026). |

---

## 3. Positioning

**One-liner (the wedge):**
> **Margin: the shared doc where everyone brings their own agents. Agents propose, humans approve, nothing gets clobbered, and it runs on your machine or your Cloudflare account.**

**Shorter form for the README and HN title:** _"Self-hosted Google Docs for your Claude Code and Codex agents, with human approval."_

**How to frame it against the closest alternatives:**
- **vs Raft:** "Raft is where your agents *talk*; Margin is where they *write together*." Position it as a complement. Ship a Raft app or external-agent integration so a Raft thread can open a Margin doc. Raft's Apps marketplace ([docs](https://docs.raft.build/features/apps.md)) and Builder Program are a distribution channel, not just a rival.
- **vs Notion/ChatGPT/Claude/Google:** "Any agent, any vendor, your infrastructure, explicit approval policy."
- **vs Outline/Docmost MCP:** "They let agents write. Margin makes agent writes **safe**: leases, held conflicts, an ordered decision log."

**What not to build:**
1. **No chat, channels or task boards.** Raft, Slack and Linear own those. Threads stay anchored to text.
2. **No hosted SaaS** and no "Margin Cloud". It conflicts with the author's constraint and with the privacy pitch.
3. **No agent runtime or model hosting.** Bring your own agent is the point. The bridge should stay thin (wake hints plus an inbox).
4. **No Notion clone** (databases, kanban, wikis with 40 block types). Stay with prose documents: specs, papers, reports.
5. **No custom editor engine.** Use Yjs with ProseMirror/Tiptap or BlockNote; the differentiation is the proposal and merge layer.
6. **No enterprise SSO, SCIM or retention** until a paying segment-3 or segment-4 user asks for it.
7. **No mobile app.** Read-only on the web is enough.

**Biggest risks:**

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Incumbents close the gap.** Notion External Agents plus ChatGPT Space plus Claude multiplayer artifacts cover 80% of the UX for most teams. Raft could add co-edited docs; it already has anchored file comments and "private deployment" on its roadmap ([pricing](https://raft.build/pricing)) | High / High | Own the parts incumbents won't ship: self-hosting, cross-vendor agents in one doc, approval policies, merge safety and the decision log. Integrate *with* Raft rather than fighting it. |
| **Self-hosting friction.** Laptops sleep; VPS hubs need TLS, backups and upgrades; a Cloudflare setup needs an account, and the Workers Free plan has daily limits (100k Durable Object requests per day, 5 GB SQLite; [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | High / High | Make "ask your agent to install it" actually work in under 5 minutes. Provide a deploy-to-Cloudflare path, `margin doctor` and `margin upgrade`, and export to Markdown or git so nobody feels locked in. |
| **Security of local agents.** Shared docs and comments become an **indirect prompt-injection** channel into agents that hold shell access and secrets. In 2026, injections through PR titles and issue text exfiltrated secrets from Claude Code, Gemini CLI and Copilot ([VentureBeat](https://venturebeat.com/security/ai-agent-runtime-security-system-card-audit-comment-and-control-2026)). OpenClaw had more than 21k publicly exposed instances ([GitHub blog](https://github.blog/open-source/maintainers/openclaw-went-viral-meet-the-maintainers-building-and-securing-it/), [Hive Security](https://hivesecurity.gitlab.io/blog/openclaw-ai-agent-security-crisis-2026/)) | Medium / Very high | Keep wake hints content-free (already the design). Per-agent scopes and read-only defaults; label who authored each piece of content when it is handed to an agent; bind to localhost by default; publish a threat model and a SECURITY.md before launch. |
| Maintainer bandwidth and sustainability | High / Medium | See §5. Keep the scope small. |

---

## 4. Distribution

**How other OSS dev tools went viral:**
- **OpenClaw** reached about 388k stars by Aug 2026 and is "the fastest-growing project in GitHub history" ([GitHub blog](https://github.blog/open-source/maintainers/openclaw-went-viral-meet-the-maintainers-building-and-securing-it/)). The demo was the marketing, each new chat-app adapter unlocked a new community, and a skills registry (ClawHub) let users extend it (third-party analyses: [growthcurve](https://growthcurve.co/openclaw-how-a-self-hosted-ai-agent-hit-escape-velocity-and-what-growth-leaders-can-learn-from-it), [finisky](https://finisky.github.io/en/openclaw-why-viral/)). The cautionary side: the hype outran security.
- **Supabase** used "open-source alternative to Firebase" positioning, launch weeks every 3–4 months, and personal outreach to more than 3,000 developers on GitHub ([DEV](https://dev.to/fmerian/how-dev-first-startup-supabase-grew-from-0-to-50k-github-stars-5d4d), [launchweek.dev](https://launchweek.dev/n/rorstro)).
- **AFFiNE** reportedly gained more than 6,000 stars in a 7-day launch week in Feb 2026 (third-party, [daily.dev](https://business.daily.dev/resources/developer-tool-launch-week-run-lessons-resend-linear-supabase/); **unverified**).
- **The pattern:** a one-line positioning against a known product, a 60-second demo that sells itself, adapters and skills that let each agent community adopt it, and repeated mini-launches.

**Channels, roughly in order of expected yield:**
1. **Agent-skill distribution.** Get listed in the Claude Code plugin marketplace (314 plugins on Sep 28, 2026, per [DevelopersDigest](https://www.developersdigest.tech/blog/best-claude-code-skills-2026)) and on skills.sh (`npx skills add`, [Skillselion](https://skillselion.com/guides/claude-skills-marketplace-guide)); also the MCP Registry and the ACP registry. Margin installs *through* agents, so this is the native channel.
2. **Targeted outreach.** Contact the authors and commenters of Claude Code issues #86760, #100904, #87961 and #91701; people posting multi-agent setups on X; contributors to awesome-raft-build; OpenClaw and Hermes users.
3. **Show HN plus a technical deep-dive** ("3-way merging agent proposals onto a live Yjs doc"). CRDT posts do well with that audience, and the Yjs community forum is a secondary venue.
4. **Subreddits:** r/selfhosted (privacy angle), r/ClaudeAI and r/LocalLLaMA (bring-your-own-agent angle).
5. **Raft ecosystem:** an app or external-agent integration, and the Builder Program.
6. **Cloudflare:** a "Deploy to Workers" template, the Workers Discord and Built-with showcases.
7. **Newsletters:** Latent Space AINews, Console.dev, TLDR AI, Changelog.
8. **Awesome lists:** awesome-selfhosted, awesome-mcp-servers, awesome-claude-code.

**30-day plan to 20 real users.** A "real user" means a hub with at least 2 humans and at least 1 agent, where at least 1 approved agent edit happened in each of 2 separate weeks.

| Week | Actions | Exit criteria |
|---|---|---|
| **1: make it demoable** | Install from one prompt in Claude Code and in Codex. Record a 60-second video: two humans, Claude Code and Codex editing one spec, one held conflict, approval by majority. Dogfood by writing project docs in Margin. Write SECURITY.md and a threat model. Build a list of 60 named prospects from the channels above | A cold install works in under 5 minutes on 3 clean machines |
| **2: hand-held design partners** | Send 60 personal DMs and emails offering a 30-minute "your agent installs it, I'm on call" session. Target 10 sessions across segments 1–3, including 2 labs and 2 agencies. Fix every friction point the same day | 8 hubs live, 5 with a second human |
| **3: public launch** | Show HN on Tuesday–Thursday morning US Pacific time, with the CRDT deep-dive posted the same day. Post to r/selfhosted and r/ClaudeAI. Submit to the Claude plugin marketplace, skills.sh, the MCP Registry and awesome lists. Start GitHub Discussions | 300+ stars, 40 installs, 12 real users |
| **4: mini launch week** | Ship one item per day: ACP bridge (any agent), deploy-to-Cloudflare, policy templates ("PI approves", "client approves"), Markdown/git export, Raft integration. Interview 10 users and write 2 case studies (one lab, one startup) | **20 real users**; weekly retention measured; top 3 asks ranked |

---

## 5. Pricing and sustainability (no hosted service)

| Option | Fit | Notes |
|---|---|---|
| **Permissive core (MIT/Apache)** | ✅ Recommended | Raft's FSL plus no-PR policy and Outline's BSL leave room for a truly open option. Contributors and labs trust MIT. |
| **GitHub Sponsors / Open Collective** | ✅ from day 1 | Low yield, but it signals legitimacy. Ask AI-tool companies whose agents benefit (OpenClaw drew sponsors such as OpenAI, NVIDIA and Vercel, per [finisky](https://finisky.github.io/en/openclaw-why-viral/), third-party). |
| **Paid setup and support** | ✅ Best near-term revenue | A fixed-fee "concierge install plus policy design" for agencies and labs, plus an annual support SLA. This matches segment 3. |
| **Commercial add-on for enterprise features** | ◐ Later | SSO/SAML, audit-log export, retention, policy-as-code, multi-hub federation. AFFiNE sells a $10/seat self-hosted Team license ([AFFiNE pricing](https://affine.pro/pricing)). Fair Core License is one way to structure it ([Keygen](https://keygen.sh/blog/keygen-is-now-fair-source/)). **Never gate agent access or MCP**: Docmost did, and the community routed around it. |
| **Template, skills and policy marketplace** | ◐ Experimental | Paid "workflow packs" (RFC review, grant proposal, legal redline) as skills plus policies. It is cheap to try, but evidence that people pay for skills is thin (**unverified**). |
| **Cloudflare / ecosystem partnership** | ◐ | Workers templates and showcase. Possible credits for users; no revenue. |
| **Grants** (NLnet / NGI, Sovereign Tech Fund) | ✅ for the EU angle | Self-hosted collaboration aligns with EU digital-sovereignty funding (eligibility **unverified**). |

**Recommendation:** MIT core plus Sponsors plus paid setup and support in the first 6 months. Decide on a commercial enterprise add-on only after 3 or more organizations ask for the same governance feature.
