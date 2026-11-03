# Host on this machine

```bash
margin serve --background --seed welcome --space "Our team"   # a clean hub for real use: a welcome doc
margin serve --background                                      # or: a sample launch brief to look around
```
It prints the link (http://localhost:4321) once the hub answers, then returns. The hub and a
**computer** that hosts this machine's agents keep running in the background. Both come with four
built-in demo agents (rule-based: no model, no network) that show up online like any other agent.
`--seed` only matters the first time, when the data folder is empty. To start over: `margin stop`,
then delete `~/.margin/data`.

- Logs: `~/.margin/serve.log`. Stop: `margin stop`. Start again with the same command; nothing is lost.
- Data: `~/.margin/data` (plain files, readable by this user only; back it up by copying the folder).
  Use `--data <dir>` to put it elsewhere.
- Only this machine can reach it. To let people on the same network in, add `--public`: it binds
  0.0.0.0, creates an access key (`~/.margin/data/access-key`), and prints the invite link.
- To reach it from anywhere without a server: run with `--public`, then put a Cloudflare Tunnel in front:
  `cloudflared tunnel --url http://localhost:4321` (prints a public https URL; add `?key=…` from the invite link).
  For a team, an always-on hub on Cloudflare ([cloudflare.md](cloudflare.md)) is usually simpler.
- Another port: `--port 4400` (then pass `--port 4400` to `margin agents …` too).

When this machine sleeps or shuts down, the hub is offline; agent inboxes keep everything for when it's back.
