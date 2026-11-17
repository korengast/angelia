# Angelia on a Linux server

This guide covers a Hetzner VPS running Ubuntu 24.04, with these pieces:

- Tailscale is the only way in.
- Claude Code and Angelia run as a user that has no sudo.
- A small desktop (xfce on TigerVNC, with Chrome) lets Claude drive a browser, and lets you step in when a login or captcha needs a person.
- Syncthing moves files between your laptop and the server.

This adapts Gal Tidhar's [AI shed](https://gal.tidhar.org.il/blog/ai-shed/) to Angelia.

Each step ends with a **Check**. Do not start the next step until the check passes.

## The shape

| | |
|---|---|
| `admin` | Your login. It has sudo and installs packages. Nothing runs as `admin`. |
| `angelia` | No sudo. It runs the Angelia daemon, Claude Code, Chrome, VNC and Syncthing as systemd user units, with linger. |
| Inbound | None from the internet. The Hetzner firewall and `ufw` both drop everything; Tailscale gets through without an open port. |
| VNC, Syncthing GUI | Bound to `127.0.0.1` only. You reach them through an SSH tunnel over Tailscale. |

Everything `angelia` can read, an agent with a shell can read too. On Linux there is no sandbox for profiles yet, so the plan below keeps the secrets on this box few and narrow. Read [Security](#security) before you pair any chat.

## 0. Create the server (Hetzner console)

1. **Server.** Pick CX33 (4 vCPU, 8 GB) or CX43 (16 GB) if you will run builds. Use x86, not ARM (CAX): Chrome has no ARM build for Linux.
   - Image: Ubuntu 24.04.
   - Add your SSH public key at creation, so the server never has a root password.
2. **Firewall.** Create a Hetzner firewall with one inbound rule: TCP 22 from your current IP only. You remove this rule in step 2. Leave outbound open.
3. **Backups.** Optional. A backup or snapshot holds every secret on the box (Claude login, WhatsApp session, `gh` token), so treat it as sensitive.

**Check:** `ssh root@<public-ip>` works with your key and asks for no password.

## 1. Base system (as root, once)

```bash
apt update && apt full-upgrade -y
apt install -y unattended-upgrades ufw git tmux jq curl ca-certificates
dpkg-reconfigure -plow unattended-upgrades          # answer Yes
timedatectl set-timezone Asia/Jerusalem             # yours; timers and logs follow it

# Swap: 8 GB with several agents and an npm ci will otherwise stall the box
fallocate -l 6G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Your admin user, with your key
adduser --disabled-password --gecos '' admin
usermod -aG sudo admin
install -d -m 700 -o admin -g admin ~admin/.ssh
install -m 600 -o admin -g admin /root/.ssh/authorized_keys ~admin/.ssh/
passwd admin                                        # sudo needs it; SSH will not accept it

# SSH: keys only, no root
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
systemctl reload ssh
```

**Check:** from a new terminal, `ssh admin@<public-ip>` works, `sudo -v` takes the password, and `ssh root@<public-ip>` is refused. Keep the root session open until this passes.

## 2. Tailscale, then close the door (as admin)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --advertise-tags=tag:server
```

In the Tailscale admin console, before `tailscale up` (`--advertise-tags` needs the tag to exist):

1. **Tag owner.** Add `tag:server` with you as its owner. A tagged node's key does not expire, so the server will not drop off the tailnet in 180 days.
2. **Access rules.** Set them so you reach the server and the server reaches nothing. A tailnet allows everything by default, so a compromised server could open ports on your laptop:

```jsonc
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:server"], "ip": ["*"] }
],
"ssh": [
  { "action": "check", "src": ["autogroup:member"], "dst": ["tag:server"], "users": ["admin", "angelia"] }
]
```

No rule has `tag:server` as its `src`, so the server can start no connection to your devices.

Then close everything public:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw enable
```

In the Hetzner console, delete the TCP 22 rule. The firewall now has no inbound rules.

**Check:**
- `tailscale ssh admin@<server>` works from your laptop.
- `ssh admin@<public-ip>` times out.
- On the server, `sudo ss -tulpn` lists nothing on `0.0.0.0` or `[::]` except `tailscaled` and `sshd`. `ufw` drops `sshd`'s port from outside, and Tailscale SSH does not use it.

## 3. The `angelia` user (as admin)

```bash
sudo adduser --disabled-password --gecos '' angelia     # no sudo, no password
sudo chmod 700 ~angelia
sudo loginctl enable-linger angelia                     # its units run at boot, with nobody logged in
sudo -l -U angelia                                      # must say: not allowed to run sudo
id angelia                                              # groups: angelia only. Never add sudo, docker, lxd or adm
```

**Check:**
- `tailscale ssh angelia@<server>` gives you a shell.
- In that shell, `systemctl --user status` answers.
- `loginctl show-user angelia -p Linger` says `Linger=yes`.

From here on, every command runs as `angelia` unless it starts with `sudo`. For those, open a second `tailscale ssh admin@<server>`.

## 4. Node and git

Node from NodeSource puts it at `/usr/bin/node`. That path survives Node upgrades, and the service file records it. The NodeSource script runs as root:

```bash
# as admin
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs gh
```

Then, as `angelia`, keep global npm packages in its own home, so `npm i -g` never needs sudo:

```bash
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile && . ~/.profile
umask 077 && echo 'umask 077' >> ~/.profile             # new files private by default
git config --global user.name "Angelia (server)"
git config --global user.email "<you>@users.noreply.github.com"
```

**GitHub, narrow:**
1. Give the server its own SSH key: `ssh-keygen -t ed25519 -C angelia-server`.
2. Add it as a **deploy key** on the repos it needs, write access only where it must push, rather than to your account. You can revoke it alone.
3. If you want `gh`: `gh auth login` with a **fine-grained token** limited to those repos.

**Check:**
- `node --version` shows 22.23.4 or newer. Older fails: Angelia needs it, so wait for NodeSource or use 24.x.
- `which node` prints `/usr/bin/node`.
- `npm prefix -g` prints `~/.local` in full (`echo ~/.local`).
- `ssh -T git@github.com` names the deploy key's repo.

## 5. Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash          # lands in ~/.local/bin
claude                                                  # log in. Full login, not a setup token
```

The login prints a URL. Open it on your laptop and paste the code back. Credentials land in `~/.claude/.credentials.json`; make sure it is mode 600.

**Check:**
- `claude -p "say ok"` answers.
- `stat -c %a ~/.claude/.credentials.json` prints `600`.

## 6. Desktop for the browser: xfce, TigerVNC, Chrome

```bash
# as admin
sudo apt install -y xfce4 xfce4-terminal dbus-x11 tigervnc-standalone-server
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

As `angelia`, set a VNC password, then add two user units: the X server, and the desktop on it.

```bash
vncpasswd                                               # no view-only password
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/vnc.service <<'EOF'
[Unit]
Description=TigerVNC display :1 (localhost only)
[Service]
ExecStart=/usr/bin/Xtigervnc :1 -localhost -rfbport 5901 -rfbauth %h/.vnc/passwd -SecurityTypes VncAuth -geometry 1600x1000 -depth 24
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > ~/.config/systemd/user/desktop.service <<'EOF'
[Unit]
Description=xfce on :1
After=vnc.service
Requires=vnc.service
[Service]
Environment=DISPLAY=:1
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/dbus-launch --exit-with-session /usr/bin/startxfce4
Restart=on-failure
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now vnc desktop
```

`-localhost` is the point: VNC's password is cut at 8 characters and its traffic is not encrypted. To reach it from the laptop, tunnel it:

```bash
ssh -N -L 5901:127.0.0.1:5901 angelia@<server>      # over the tailnet, then open vnc://localhost:5901
```

**Inside the VNC desktop:**
1. Open Chrome.
2. Sign in with a **dedicated Google account**, not your main one.
3. Install the **Claude in Chrome** extension and log in.
4. Leave this Chrome running. Sessions started with `--chrome` drive it.

**Check:**
- `ss -tlnp | grep 5901` shows only `127.0.0.1`.
- The tunnel shows the xfce desktop.
- After `sudo reboot`, the desktop comes back on its own.

## 7. Syncthing (laptop ⇄ server)

```bash
# as admin
sudo apt install -y syncthing
# as angelia
systemctl --user enable --now syncthing
mkdir -p ~/sync/in ~/sync/out
```

The GUI listens on `127.0.0.1:8384`. Reach it with `ssh -N -L 8384:127.0.0.1:8384 angelia@<server>`. In the GUI:

1. **Settings → GUI.** Set a user and password.
2. **Settings → Connections.**
   - Listen address: `tcp://<server-tailscale-ip>:22000`.
   - Turn off global discovery, relaying and NAT traversal. Sync then goes only over the tailnet.
3. **Add your laptop** as a device, using its Tailscale IP: `tcp://100.x.y.z:22000`.
4. **Share the folders.**
   - `~/sync/in` is **Receive Only** on the server: you hand files in.
   - `~/sync/out` is **Send Only** on the server: results come out.

On the laptop, keep the synced `out` folder away from anything that runs or opens files on its own: not `~`, not the Desktop, not a watched folder.

This grant goes in the Tailscale access rules from step 2, which so far let the server start nothing. Add it, or the server cannot reach the laptop:

```jsonc
{ "src": ["tag:server"], "dst": ["<your-laptop>"], "ip": ["tcp:22000"] }
```

**Check:**
- A file dropped into the laptop's `in` appears on the server.
- `ss -tlnp` shows 8384 only on `127.0.0.1`, and 22000 only on the Tailscale IP.

## 8. Angelia

Linux support ships in 0.3.26 and is marked experimental until the runbook checks below pass on a real server.

```bash
curl -fsSL https://useangelia.com/install | sh       # checks the release signature; installs under ~/.local
angelia --version                                    # 0.3.26 or newer
angelia init                     # the wizard; the WhatsApp QR prints in this terminal
angelia check-config
angelia service install          # writes ~/.config/systemd/user/angelia.service, enables it, starts it
```

WhatsApp allows one linked device per running copy. Stop the Mac's daemon first (`angelia service uninstall` there), or pair a separate number.

Expect a tmux version warning: Ubuntu 24.04 ships tmux 3.4. Angelia still runs.

**Check:** run the six steps in [runbook → Linux server over Tailscale](runbook.md#linux-server-over-tailscale). They cover:
- the service;
- a reboot with nobody logged in;
- `/restart` keeping tmux panes;
- `angelia update`;
- `/restart` with a `$` in the config path;
- a `.inbox` link being refused.

Then send the maintainers your distro and systemd version (`systemctl --version | head -1`), so they can drop the word "experimental".

## Security

### Done by the steps above

- **No root anywhere it matters.**
  - Root cannot log in.
  - `admin` has sudo but runs nothing.
  - `angelia` has no sudo and belongs to no privileged group. `docker`, `lxd` and `adm` are each as good as root, or close to it.
  - Nothing Angelia needs, `service install` and `/restart` included, asks for sudo. The one exception is linger, which you set in step 3.
- **No public port.**
  - The Hetzner firewall and `ufw` both drop inbound traffic.
  - Angelia opens no port at all. Its API is a Unix socket under `~/.angelia`.
  - VNC and the Syncthing GUI are on localhost, and Syncthing's sync port is on the tailnet only.
- **The server cannot reach your devices.** Tailscale grants no `tag:server` source except Syncthing's one port to the laptop. Tailscale SSH uses `check` mode, which asks you to re-authenticate in the browser periodically.
- **Private files.** The home folder is 700 and `umask 077` applies, so files are created private. Angelia keeps `~/.angelia/env` at 600, and Claude keeps its credentials at 600.
- **Angelia's deny floor** keeps the agents' file tools away from:
  - Claude's `.credentials.json`, `~/.ssh`, `gh`'s login and Angelia's own secrets.
  - Chrome's and Firefox's profiles, and the keyrings.
  - `~/.config/systemd/user`, so an agent cannot plant a unit that runs at boot.
- **Patches.** `unattended-upgrades` covers the OS and the NodeSource and Chrome repositories. Angelia's updates are signed (`angelia update`). Claude Code updates itself.

### What stays open, and what to do about it

1. **A shell reads everything `angelia` can.** The deny floor stops the file tools and a plain `cat`. It does not stop a script the agent writes. On macOS `sandbox: true` closes that gap; on Linux it is not built yet. So, on this box:
   - **No `bypassPermissions` on any profile someone else can message.** Use `acceptEdits` or `default` there, so a shell command asks you first.
   - Keep `bypassPermissions` for a profile only you talk to.
   - Do not use the article's `--dangerously-skip-permissions` on anything that reads chat or web content. Prompt injection then has the whole account.
2. **Make each credential worth little if it leaks.** Assume an agent can read them all:
   - The Claude login.
   - A dedicated Google account in Chrome.
   - Deploy keys and a fine-grained `gh` token, limited to the repos the server needs.
   - **No cloud API keys on this box:** no Hetzner token and no AWS keys. Whoever holds them can rebuild the server.
3. **The browser is an agent's tool.** Whatever that Chrome is logged into, an agent with `--chrome` can use. Log it into only what you would let the agent do alone.
4. **The WhatsApp session** in `~/.angelia/wa/` is as good as the linked device. Reading it would mean getting past the deny floor (point 1). Hetzner snapshots copy it too.
5. **Synced files are inputs.** Anything in `~/sync/in` can carry a prompt injection, like any other file. Do not put it in a bypass profile's `add_dirs`.
6. **Other users' processes are visible.** By default `ps` shows `admin`'s processes too. `angelia` cannot touch them. To hide them, mount `/proc` with `hidepid=invisible`; that can upset polkit and logind, so test it before you rely on it.

### Quick audit (run any time)

```bash
sudo ss -tulpn                                # nothing public except tailscaled
sudo ufw status verbose                       # deny incoming; allow in on tailscale0
sudo -l -U angelia; id angelia                # no sudo; no extra groups
stat -c '%a %n' ~angelia ~angelia/.angelia ~angelia/.angelia/env ~angelia/.claude/.credentials.json
                                              # 700 700 600 600
sudo grep -h '^Permit\|^Password' /etc/ssh/sshd_config.d/*.conf
```
