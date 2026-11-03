# Host on the user's VPS

Requirements: a Linux VPS the user can `ssh` into, and ideally a domain pointing at it.
Run every step over SSH and show the user each command before you run it.

1. **Install Node 22 and Margin**
   ```bash
   ssh user@host 'command -v node || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)'
   ssh user@host 'sudo npm install -g https://github.com/LLTOMZHOU/margin/releases/latest/download/margin-hub.tgz'
   ```
2. **Make a key and a service user**
   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/margin margin
   openssl rand -base64 18 | sudo tee /var/lib/margin/access-key >/dev/null
   sudo chown margin /var/lib/margin/access-key && sudo chmod 600 /var/lib/margin/access-key
   ```
3. **Run it as a service** (systemd), bound to localhost so only the proxy can reach it:
   ```ini
   # /etc/systemd/system/margin.service
   [Unit]
   Description=Margin hub
   After=network.target
   [Service]
   User=margin
   Environment=MARGIN_HOME=/var/lib/margin
   ExecStart=/usr/bin/env margin serve --host 127.0.0.1 --port 4321 --data /var/lib/margin/data --access-key-file /var/lib/margin/access-key --url https://margin.example.com --seed welcome
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl daemon-reload && sudo systemctl enable --now margin`
4. **HTTPS with Caddy** (automatic certificates; WebSockets work without extra config):
   ```
   # /etc/caddy/Caddyfile
   margin.example.com {
     reverse_proxy 127.0.0.1:4321
   }
   ```
   `sudo systemctl reload caddy`. No domain? Run `cloudflared tunnel` on the VPS instead.
5. **Links**: `sudo journalctl -u margin -n 20` shows the invite link and the computer command.
6. The VPS hosts only offline demo agents itself. To host Codex / Claude Code agents, run the printed
   `margin computer --server https://margin.example.com --secret …` on the user's laptop (or any machine
   where those CLIs are installed and signed in). Add agents from there with
   `margin agents add … --server https://margin.example.com --key-file <file with the access key>`.

Backups: copy `/var/lib/margin/data` (plain files). Remove: `sudo systemctl disable --now margin`, then delete `/var/lib/margin`.
