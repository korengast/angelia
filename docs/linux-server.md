# Angelia on a Linux server

This guide covers a Hetzner VPS running Ubuntu 26.04 (24.04 works too), with these pieces:

- Tailscale is the only way in.
- Claude Code and Angelia run as a user that has no sudo.
- Optional: a small desktop with Chrome for agents that drive a browser.
- Optional: Syncthing to move files between your laptop and the server.
- Optional: Claude Remote Control.
- Optional: a twice-daily sync of the workspace to a private repo.

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

A new Hetzner account may have to pass a verification first, by credit card or ID document, before it can create a server. Turn on two-factor authentication for the account too: whoever gets into it controls the server.

1. **Project.** Create a project for it (here `angelia`), so its firewall, keys and billing stay apart from anything else.
2. **Firewall** (Firewalls → Create Firewall). One inbound rule: TCP 22 from your current IP only (`curl -s https://api.ipify.org`). You remove it in step 2. Leave outbound open.
   - The form starts with TCP 22 and ICMP from any address. Remove both "Any" sources and the ICMP rule.
   - In the source field, Enter confirms the address but can also submit the whole form. Check the rules on the firewall's page afterwards.
3. **Server** (Servers → Add Server).
   - **Type:** x86 only, not ARM: Chrome has no ARM build for Linux. Measured 2026-11-17: the cheaper Cost-Optimized (CX) line was out of stock. In the Regular Performance line, CPX22 (2 vCPU, 4 GB, 80 GB) was $19.49/mo and CPX32 (4 vCPU, 8 GB) $35.49. CPX12 (2 GB) is too small once the desktop and Chrome from step 6 run.
   - **Size can only grow.** Rescaling to a smaller type fails once the disk is bigger, so start small.
   - **Location:** Helsinki has no surcharge. Nuremberg and Falkenstein add $3.50 to $6.50/mo for about 10 ms less latency from the Middle East, which a chat bot does not notice.
   - **Image:** Ubuntu 26.04 LTS (systemd 259, tmux 3.6). 24.04 works too.
   - **The rest:** public IPv4 ($0.60/mo) and IPv6 on, your SSH public key added (then no root password is ever sent), the firewall from above selected.
4. **Backups.** Optional. A backup or snapshot holds every secret on the box (Claude login, WhatsApp session, `gh` token), so treat it as sensitive.

**Check:** `ssh root@<public-ip>` works with your key and asks for no password.

## 1. Base system (as root, once)

```bash
export DEBIAN_FRONTEND=noninteractive
apt update && apt full-upgrade -y
apt install -y unattended-upgrades ufw git tmux jq curl ca-certificates
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone Asia/Jerusalem             # yours; timers and logs follow it

# Swap, the size of the RAM: several agents and an npm ci will otherwise stall the box
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Your admin user, with your key, and sudo without a password
adduser --disabled-password --gecos '' admin
usermod -aG sudo admin
install -d -m 700 -o admin -g admin ~admin/.ssh
install -m 600 -o admin -g admin /root/.ssh/authorized_keys ~admin/.ssh/
echo 'admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-admin && chmod 440 /etc/sudoers.d/90-admin && visudo -c
```

`admin` has no password at all. Getting in already takes your SSH key or your tailnet login, and nothing runs as `admin`. If you want sudo to ask for a password anyway, run `passwd admin` and drop the sudoers line.

Test `admin` from a second terminal before you lock root out: `ssh admin@<public-ip> sudo -n true` must succeed. Then:

```bash
# SSH: keys only, no root
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers admin angelia
X11Forwarding no
AllowAgentForwarding no
EOF
sshd -t && systemctl reload ssh
```

**Check:**
- `ssh admin@<public-ip> sudo -n true` works.
- `ssh root@<public-ip>` says `Permission denied (publickey)`.
- `sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|x11forwarding|allowagentforwarding) '` prints `no` for all four. TCP forwarding stays on, since tunnels need it.

## 2. Tailscale, then close the door (as admin)

**On your laptop:** install Tailscale (`brew install --cask tailscale`, or the App Store) and sign in. Signing in the first time creates your tailnet.

**In the admin console** (Access controls → JSON editor), replace the default policy. The default lets every device reach every other, so a compromised server could open ports on your laptop. Put in your laptop's Tailscale IP (`tailscale ip -4` on it):

```jsonc
{
	"tagOwners": {
		"tag:server": ["autogroup:admin"],
	},
	"grants": [
		// Your own devices, to each other (tagged servers are not part of autogroup:self).
		{"src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"]},
		// You, to the server. No rule has tag:server as src, so it starts no connection.
		{"src": ["autogroup:member"], "dst": ["tag:server"], "ip": ["*"]},
	],
	"ssh": [
		{"action": "check", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"]},
	],
	"tests": [
		{"src": "tag:server", "deny": ["<laptop-tailscale-ip>:22"]},
	],
}
```

- **The tag must exist before the server joins.** `--advertise-tags` fails for a tag the policy does not name. A tagged node's key does not expire, so the server will not drop off the tailnet after 180 days.
- **The `tests` block checks the policy on every save.** A policy that lets the server reach your laptop is refused.
- **No Tailscale SSH for the server.** You reach it with plain `ssh` and your key, over its tailnet address. That keeps two locks, the tailnet and the key, and works for scripts. Tailscale SSH's `check` mode would ask for a browser login instead.

**On the server:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-tags=tag:server --hostname=angelia     # prints a login link: open it, Connect
tailscale ip -4                                                       # the server's tailnet address
```

From here on, use `ssh admin@<tailnet-ip>`, or `ssh admin@angelia` with MagicDNS. Then close everything public:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw --force enable
```

In the Hetzner console, delete the TCP 22 rule. The firewall now has no inbound rules; keep it attached as a second wall.

**Check:**
- `ssh admin@<tailnet-ip>` works from your laptop.
- `ssh admin@<public-ip>` times out.
- On the server, `timeout 5 bash -c '</dev/tcp/<laptop-tailscale-ip>/22'` fails. `tailscale ping` still answers, since it is not a connection the policy governs.
- `sudo ss -tulpn` shows only `tailscaled` and `sshd` on `0.0.0.0`/`[::]`. `ufw` drops `sshd`'s port from the internet.

## 3. The `angelia` user (as admin)

```bash
sudo adduser --disabled-password --gecos '' angelia     # no sudo, no password
sudo chmod 700 ~angelia
sudo loginctl enable-linger angelia                     # its units run at boot, with nobody logged in
sudo -l -U angelia                                      # must say: not allowed to run sudo
id angelia                                              # angelia (and users on 26.04). Never add sudo, docker, lxd or adm
```

**Check:**
- `ssh angelia@<tailnet-ip>` gives you a shell. Copy your key first: `sudo install -d -m 700 -o angelia -g angelia ~angelia/.ssh && sudo install -m 600 -o angelia -g angelia ~/.ssh/authorized_keys ~angelia/.ssh/`.
- In that shell, `systemctl --user status` answers.
- `loginctl show-user angelia -p Linger` says `Linger=yes`.

From here on, every command runs as `angelia` unless it starts with `sudo`. For those, open a second `ssh admin@<tailnet-ip>`.

## 4. Node and git

Node from NodeSource puts it at `/usr/bin/node`. That path survives Node upgrades, and the service file records it. The NodeSource script runs as root:

```bash
# as admin
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
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

**GitHub, narrow.** Give the server its own SSH key: `ssh-keygen -t ed25519 -C angelia-server`. Then pick one:

- **Deploy keys.** Add the key as a deploy key on each repo the server needs, with write access only where it must push. You can revoke it alone.
- **A machine account,** when agents open pull requests across several repos. Measured here: a dedicated bot user with write access to the org's repos. Log `gh` in as the bot. The device-code login works over SSH, so no token is pasted anywhere:

  ```bash
  ssh -t angelia@<tailnet-ip> 'gh auth login --hostname github.com --git-protocol ssh --web'
  ```

  - Answer "Upload your SSH public key" with `~/.ssh/id_ed25519.pub`, and open github.com/login/device signed in as the bot, not as yourself.
  - Ubuntu's `gh` 2.46 has no `--skip-ssh-key`.
  - With no keyring on the server, the token lands in `~/.config/gh/hosts.yml` (mode 600). The deny floor keeps agents' file tools out of it.
  - **Then drop the key-upload scope.** The login granted `admin:public_key`, which lets the token add more SSH keys to the bot. A key added that way outlives the token. Remove the scope with `gh auth refresh -h github.com -r admin:public_key` and approve the code again as the bot.

**Check:**
- `node --version` shows 24.22.1 or newer (measured: 24.22.3). Ubuntu 26.04's own `nodejs` is 22.22.1, too old for Angelia.
- `which node` prints `/usr/bin/node`.
- `npm prefix -g` prints `~/.local` in full (`echo ~/.local`).
- `ssh -T git@github.com` names the deploy key's repo, or the bot's account.
- With a machine account: `gh auth status` lists scopes without `admin:public_key` (measured: `gist`, `read:org`, `repo`).

## 5. Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash          # lands in ~/.local/bin
```

From your laptop, log in with a real terminal (the login is interactive):

```bash
ssh -t angelia@<tailnet-ip> '~/.local/bin/claude'       # /login; full login, not a setup token
```

For profiles with `sandbox: true`, Claude Code's sandbox on Linux is bubblewrap, and it needs `socat` for its proxy. As admin:

```bash
sudo apt install -y bubblewrap socat
```

Ubuntu 24.04+ restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`). It also ships an AppArmor profile for `bwrap`, so `bwrap` still works. Check it as `angelia`: `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all echo ok` must print `ok` (measured on 26.04).

The login prints a URL. Open it on your laptop and paste the code back. Credentials land in `~/.claude/.credentials.json`; make sure it is mode 600.

**Check:**
- `claude -p "say ok"` answers.
- `stat -c %a ~/.claude/.credentials.json` prints `600`.

## 6. Optional: a desktop for the browser (xfce, TigerVNC, Chrome)

Skip this unless agents need a browser (`--chrome`), or you need to step in for a login or a captcha. Angelia runs without it. On a 4 GB server it costs about 0.5 GB of RAM while it runs. Measured 2026-11-17 on 26.04: installed, then turned off with `systemctl --user disable --now desktop vnc`.


```bash
# as admin
sudo apt install -y xfce4 xfce4-terminal dbus-x11 tigervnc-standalone-server
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

As `angelia`, set a VNC password, then add two user units: the X server, and the desktop on it.

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/vnc.service <<'EOF'
[Unit]
Description=TigerVNC display :1 on a Unix socket only angelia can open
[Service]
ExecStart=/usr/bin/Xtigervnc :1 -rfbport -1 -rfbunixpath %h/.vnc/vnc.sock -rfbunixmode 0600 -SecurityTypes None -geometry 1600x1000 -depth 24 -nolisten tcp
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

There is no VNC password and no TCP port: the server listens on a Unix socket that only `angelia` can open, and you reach it with your SSH key over the tailnet. Create the folder first with `mkdir -m 700 ~/.vnc`.

```bash
ssh -N -L 5901:<angelia-home>/.vnc/vnc.sock angelia@<tailnet-ip>   # then open vnc://localhost:5901
```

`<angelia-home>` is the `angelia` user's home folder (`echo ~angelia` on the server).

macOS Screen Sharing may refuse a server without a VNC password. TigerVNC's viewer (`brew install --cask tigervnc-viewer`) connects.

**Inside the VNC desktop:**
1. Open Chrome.
2. Sign in with a **dedicated Google account**, not your main one.
3. Install the **Claude in Chrome** extension and log in.
4. Leave this Chrome running. Sessions started with `--chrome` drive it.

**Check:**
- `ss -tlnp` shows no VNC port, and `~/.vnc/vnc.sock` is `srw-------`.
- The tunnel shows the xfce desktop.
- After `sudo reboot`, the desktop comes back on its own.

## 7. Optional: Syncthing (laptop ⇄ server)

Skip this unless you want to hand files to agents, and take results back, without `scp`. Angelia runs without it.

- **Who dials whom.** If you set it up, let the laptop dial the server (`tcp://<server-tailnet-ip>:22000`), so the tailnet policy needs no grant from `tag:server`.
- **Homebrew on macOS:** `brew services start syncthing` stays down until `/opt/homebrew/var/log` exists.


```bash
# as admin
sudo apt install -y syncthing
# as angelia
systemctl --user enable --now syncthing
mkdir -p ~/sync/in ~/sync/out
```

The GUI listens on `127.0.0.1:8384`. Reach it with `ssh -N -L 8384:127.0.0.1:8384 angelia@<tailnet-ip>`. In the GUI:

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

Run the installer with `ssh -t`: its last step opens `/dev/tty`, and without one it prints `cannot open /dev/tty` after installing.

**Trust the workspace once.** Claude Code ignores a profile's `add_dirs` until the folder has passed its trust dialog. The log line reads `Ignoring 1 permissions.additionalDirectories entry … this workspace has not been trusted`. Set the flag without the dialog:

```bash
jq '.projects["'"$HOME"'/.angelia/workspace"].hasTrustDialogAccepted = true' ~/.claude.json > ~/.claude.json.new && mv ~/.claude.json.new ~/.claude.json
```

Expect a tmux version warning if Ubuntu's tmux is older than 3.7 (24.04 has 3.4, 26.04 has 3.6). Angelia still runs.

**Check:** run the six steps in [runbook → Linux server over Tailscale](runbook.md#linux-server-over-tailscale):
- the service;
- a reboot with nobody logged in;
- `/restart` keeping tmux panes;
- `angelia update`;
- `/restart` with a `$` in the config path;
- a `.inbox` link being refused.

Measured 2026-11-17 on Ubuntu 26.04.1, systemd 259, Angelia 0.3.26:
- **Service:** `active`, linger on.
- **Reboot with nobody logged in:** the daemon was up 11 s after boot, and WhatsApp reconnected.
- **`/restart` from a group:** the chat heard "Restarting now" and then "Angelia is back up". The restarter ran as its own unit (`angelia is up under systemd` in `daemon.out`), and `NRestarts=0`.
- **Not yet measured:** `angelia update` (no newer release), a `$` in the config path, and the `.inbox` link.

Send the maintainers your distro and systemd version (`systemctl --version | head -1`), so they can drop the word "experimental".

### Moving an instance from a Mac

Measured 2026-11-17, moving a 0.3.25 Mac instance to 0.3.26 here.

1. **On the Mac.** Back up the instance (`cp -a ~/.angelia ~/.angelia.bak-<date>`), then run `angelia service uninstall` and `angelia jobs remove <profile>` for each profile with jobs. The WhatsApp link must run in one place only.
2. **Copy it over the tailnet:**

   ```bash
   rsync -a --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --exclude api.sock --exclude daemon.pid --exclude status.json --exclude sessions.json ~/.angelia/ angelia@<tailnet-ip>:.angelia/
   ```

   - `wa/` moves with it, so WhatsApp needs no new pairing.
   - `sessions.json` stays behind: its Claude sessions live in the Mac's `~/.claude`.
3. **On the server.**
   - Rewrite the paths: `grep -rIl /Users/<you> --exclude-dir=wa ~/.angelia | xargs sed -i "s#/Users/<you>#$HOME#g"`.
   - Clone every `add_dirs` repo to the same place under `$HOME`.
   - Run `angelia check-config`, `angelia accept --check`, and `angelia compile <profile> --write` for each profile. The Linux deny rules (keyrings, `.config/google-chrome`, `.config/systemd/user`) arrive only with that compile.
   - Run `angelia service install`.
4. **Jobs do not move.** `angelia jobs install` is macOS only. Write systemd timers that call `angelia jobs run <profile> <job>`, or leave the jobs off.

### `sandbox: true` on Ubuntu 26.04

Measured 2026-11-17 with Claude Code 2.1.327 and Angelia 0.3.26.

**1. It does not start.** `bwrap` itself works, but every sandboxed command fails with `apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted …)`.

- The kernel log shows `apparmor="DENIED" profile="unpriv_bwrap" capability=sys_admin`.
- Ubuntu's `bwrap-userns-restrict` profile runs everything inside an unprivileged bwrap under `unpriv_bwrap`, which has `audit deny capability`.
- A `deny` cannot be lifted from `local/unpriv_bwrap`.

The fix, as root, gives Claude a `bwrap` copy under its own profile. Ubuntu's `/usr/bin/bwrap` keeps its restrictive one:

```bash
install -d -m 755 /usr/local/lib/claude-bwrap && install -m 755 /usr/bin/bwrap /usr/local/lib/claude-bwrap/bwrap
printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' 'profile claude-bwrap /usr/local/lib/claude-bwrap/bwrap flags=(unconfined) {' '  userns,' '}' > /etc/apparmor.d/claude-bwrap
apparmor_parser -r /etc/apparmor.d/claude-bwrap
echo 'DPkg::Post-Invoke { "[ -x /usr/bin/bwrap ] && install -m 755 /usr/bin/bwrap /usr/local/lib/claude-bwrap/bwrap || true"; };' > /etc/apt/apt.conf.d/99claude-bwrap
```

Then, as `angelia`: `ln -sf /usr/local/lib/claude-bwrap/bwrap ~/.local/bin/bwrap`.

- **Use the PATH link, not `sandbox.bwrapPath`.** The sandbox finds `bwrap` on `PATH`. `sandbox.bwrapPath` in `~/.claude/settings.json` or `--settings` did not change it: the denial still named `unpriv_bwrap`.
- **The service's PATH already starts with `~/.local/bin`.**
- **The cost:** that one binary may create user namespaces, as every program could before Ubuntu 24.04.

**2. Once it starts, it holds in `acceptEdits`, and not in `bypassPermissions`.** Probes from a sandboxed Bash in a compiled profile:

| Probe | `acceptEdits` | `bypassPermissions` |
|---|---|---|
| Write to `~` | refused (`Read-only file system`) | refused |
| Write in the profile folder | allowed | allowed |
| Open `~/.angelia/api.token` (`Read(...)` deny) | refused (`Permission denied`) | **readable** |
| `curl https://example.com` (not in `allowedDomains`) | refused (`deny network-outbound`) | **200** |

- **Keep `bypassPermissions` off every sandboxed Linux profile.** With it, the sandbox still blocks writes but not reads or network.
- **Optionally keep shell commands asking anyway.** With the sandbox on, Claude Code runs Bash without asking. For chats other people write in, `"sandbox": {"autoAllowBashIfSandboxed": false}` in the profile's `.claude/settings.local.json` makes every command go to an owner too. Note that `echo` and other read-only commands still run without asking.

## 9. Optional: Claude Remote Control in `~/.angelia`

A Claude session on the server that you open from claude.ai/code or the Claude app, for looking after the instance (logs, the table, `angelia` commands) without SSH. It starts at boot.

As `angelia`, once: trust the folder, then answer Remote Control's one-time consent at a real terminal.

```bash
jq '.projects["'"$HOME"'/.angelia"].hasTrustDialogAccepted = true' ~/.claude.json > ~/.claude.json.new && mv ~/.claude.json.new ~/.claude.json
```

```bash
ssh -t angelia@<tailnet-ip> 'cd ~/.angelia && ~/.local/bin/claude remote-control --name angelia-server --permission-mode default'
# answer y to "Enable Remote Control?", wait until it is connected, then Ctrl+C
```

Without that consent the service exits with `"Enable Remote Control?" got no answer`.

Then add the unit:

```ini
# ~/.config/systemd/user/claude-rc.service
[Unit]
Description=Claude Remote Control in ~/.angelia
After=network-online.target

[Service]
WorkingDirectory=%h/.angelia
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/claude remote-control --name angelia-server --permission-mode default
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now claude-rc
```

- **The account matters.** Remote Control needs the full login from step 5, not a setup token. The session appears under that account's claude.ai/code.
- **This session is not an Angelia profile.** None of the deny floor applies to it: it can read `~/.angelia/env`, `wa/` and `api.token`.
- **Who can drive it.** Anyone who gets into that claude.ai account can. Keep the account's 2FA on, and keep the session's permission mode at `default`, never `bypassPermissions`.

**Check:**
- `systemctl --user is-active claude-rc` prints `active`, and `NRestarts=0`.
- `journalctl --user -u claude-rc` shows `Capacity: 0/32` and a `claude.ai/code?environment=…` link.
- `angelia-server` is listed in claude.ai/code. Measured 2026-11-18 with Claude Code 2.1.327.

## 10. Optional: sync the workspace to a private repo twice a day

The workspace is the instance's memory: profiles, instructions and the table. A server lost without it is lost for good.

- **The `.gitignore` written by `angelia init` keeps secrets out:** `.state/`, `**/.claude/settings.local.json` (where profile tokens live), `.env`, keys.
- **Check before the first push:** `git ls-files | grep -E 'settings.local|\.state/|token'` must print nothing.

**The repo.** Create a private repo with the server's GitHub identity:

```bash
gh repo create <org>/angelia-workspace --private
```

**The script**, `~/.local/bin/angelia-workspace-sync` (mode 700). It commits, merges `origin/main`, and pushes. On a conflict it aborts the merge and pushes nothing:

```sh
#!/bin/sh
set -eu
cd "$HOME/.angelia/workspace"
git remote get-url origin >/dev/null 2>&1 || git remote add origin git@github.com:<org>/angelia-workspace.git
git add -A
git diff --cached --quiet || git commit -q -m "sync: $(hostname) $(date +%Y-%m-%dT%H:%M%z)"
git fetch -q origin
if git rev-parse -q --verify origin/main >/dev/null; then
  git merge -q --no-edit origin/main || { git merge --abort; echo "merge conflict; nothing pushed" >&2; exit 1; }
fi
git push -q origin HEAD:main
```

**The units**, in `~/.config/systemd/user/`:

- `angelia-workspace-sync.service`: `Type=oneshot`, `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `ExecStart=%h/.local/bin/angelia-workspace-sync`.
- `angelia-workspace-sync.timer`: `OnCalendar=*-*-* 16,23:00:00`, `Persistent=true` (a sync missed while the server was down runs at boot), `WantedBy=timers.target`.

```bash
systemctl --user enable --now angelia-workspace-sync.timer
```

**A merged table does not take effect on its own.** A `routing.yaml` changed on GitHub and merged here still waits for `angelia accept` (or `/restart confirm`), because the daemon runs on the accepted copy.

**Check:**
- `systemctl --user start angelia-workspace-sync` logs `synced <commit>`.
- `systemctl --user list-timers` shows the next run.
- `git ls-tree -r --name-only origin/main | grep settings.local` prints nothing.

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
  - If you set up the optional desktop or Syncthing: VNC listens on a Unix socket only `angelia` can open, and Syncthing's GUI on localhost and its sync port on the tailnet only.
- **The server cannot reach your devices.** No Tailscale grant has `tag:server` as its source. SSH to the server needs both your tailnet login and your key; the policy's `tests` block refuses any change that lets the server reach your laptop.
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
