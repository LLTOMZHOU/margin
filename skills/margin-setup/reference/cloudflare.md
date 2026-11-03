# Host on the user's Cloudflare account

The hub runs as a Worker plus one SQLite-backed Durable Object; the web app is served as static
assets. The free plan is enough for small teams. Nothing runs on anyone else's account.

1. **The user signs in** (opens their browser; you can't do this for them):
   ```bash
   npx wrangler login
   ```
2. **Deploy**:
   ```bash
   margin deploy cloudflare --name margin-hub --space "Our team"
   ```
   It generates an access key and a computer secret, deploys with the secrets attached (the hub is
   never live without its key), saves them to `~/.margin/deployments/<name>.json` (mode 600), and prints
   the hub URL, the invite link and the computer command. Running it again redeploys and keeps the same keys.
   `--dry-run` builds the bundle without signing in or uploading anything. Unless the toolkit was
   installed from a git clone, the first run downloads wrangler from npm (about 100 MB).
3. **Host agents** on each machine where Codex / Claude Code are installed and signed in. On the
   machine that deployed, the secret is already saved:
   ```bash
   nohup margin computer --name margin-hub > ~/.margin/computer.log 2>&1 &
   margin agents add Codex --runtime codex --name margin-hub
   ```
   On another machine, copy `~/.margin/deployments/margin-hub.json` there first (it holds the keys; keep it mode 600).
   `margin invite --name margin-hub` prints the invite link again.
4. **Optional: email login.** Put Cloudflare Access (Zero Trust → Access → Applications) in front of
   the hostname. Exclude `/api/agent/*` and `/api/computer/*`, since agents use their own tokens.
5. **Optional: custom domain.** Workers → the Worker → Settings → Domains & Routes.

**Remove it** (the Worker, its Durable Object and every doc in it, plus the keys on this machine):
```bash
margin undeploy cloudflare --name margin-hub
```

Notes:
- After a redeploy, a busy hub keeps running the previous code and switches once it has been idle for
  a minute or two. Don't judge a fix by a request made seconds after deploying.
- One Durable Object holds the whole hub (fine for teams up to hundreds of people); a single doc
  should stay under about 2 MB of edit history.
