#!/bin/sh
# Angelia installer: curl -fsSL https://raw.githubusercontent.com/korengast/angelia/<release tag>/install.sh | sh
#
# Does three things and nothing else: checks Node 22+, installs the newest release the way
# `angelia update` does (clone the tag, build, pack, npm i -g, no dependency install scripts), then
# runs `angelia init` unless an instance already exists. It never clones into your home, never
# builds in place, and never touches an existing instance.
#
# The release it installs must be a tag signed by one of the release keys below (the owner's, and the
# release workflow's, which lives only in the repository's `release` environment on GitHub), and the
# tag must name itself: a new tag pushed by anyone without a key is refused. Fetch this script from a tag (the
# README's line does), so the key it carries is the one that release shipped. The same key is in
# allowed_signers, which the installed copy keeps: `angelia update` checks every later release
# against it. ANGELIA_REF set to a branch installs that branch unsigned, and says so.
set -eu

# One line per key, the format of git's gpg.ssh.allowedSignersFile. Kept equal to allowed_signers by a test.
SIGNERS='korengast@users.noreply.github.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK9Krso/DJH0yfzU2ACgmKYZtCBs4OOeVEX6+KONrUJk
release-ci@useangelia.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFkVpARRjsFeKy3JdX/TN+0Tco/p94MePKMKe11UPiI4'

REPO="${ANGELIA_REPO:-https://github.com/korengast/angelia.git}"
STATE="${ANGELIA_STATE_DIR:-$HOME/.angelia}"

say() { printf '%s\n' "$*"; }
die() { stop_anim; [ -s "${tmp:-/nonexistent}/log" ] && tail -20 "$tmp/log" >&2; say "install: $*" >&2; exit 1; }

# The banner, as `angelia init` draws it (src/cli/banner.ts; a test keeps the two equal). On a terminal
# it is drawn first, in clay, and while the release is fetched, checked and built the character blinks:
# its eyes close for a moment every three seconds, twice in a row every third time, with the current
# step and a spinner under it. Plain and eyes open with NO_COLOR, eyes open with
# ANGELIA_NO_ANIMATION=1, absent when output is not a terminal.
ART1=' ///   /\     ┌─┐┌┐┌┌─┐┌─┐┬  ┬┌─┐'
ART2='///   /oo\    ├─┤││││ ┬├┤ │  │├─┤'
ART2_SHUT='///   /--\    ├─┤││││ ┬├┤ │  │├─┤'
ART3='     /____\   ┴ ┴┘└┘└─┘└─┘┴─┘┴┴ ┴'
TAGLINE='your coding agent, your personal assistant'
tty=0; colour=0; anim=0; anim_pid=''
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  tty=1
  [ -z "${NO_COLOR:-}" ] && colour=1
  [ "$colour" = 1 ] && [ -z "${ANGELIA_NO_ANIMATION:-}" ] && anim=1
fi
# Clay #D06B6B, or the nearest of 256 colours (174) when the terminal does not say it has 24-bit.
case "${COLORTERM:-}" in truecolor|24bit) CLAY='\033[38;2;208;107;107m' ;; *) CLAY='\033[38;5;174m' ;; esac
# The art in clay; $1 is the eyes' line (ART2, or ART2_SHUT mid-blink).
draw_art() {
  printf "\\r\\033[K${CLAY}%s\\033[0m\\n\\r\\033[K${CLAY}%s\\033[0m\\n\\r\\033[K${CLAY}%s\\033[0m\\n" "$ART1" "$1" "$ART3"
}
tagline() { printf '\r\033[K\033[2mAngelia%s · %s\033[0m\n' "${1:+ $1}" "$TAGLINE"; }
banner() {
  [ "$tty" = 1 ] || return 0
  if [ "$colour" = 1 ]; then draw_art "$ART2"; tagline ''; else printf '%s\n%s\n%s\nAngelia · %s\n' "$ART1" "$ART2" "$ART3" "$TAGLINE"; fi
  # The step line is the one under the tagline, where the cursor is now.
  [ "$anim" = 1 ] && printf '\033[?25l'
  return 0
}
# Redraws the banner and the step line in place, from the line the cursor is on (the step line).
# A stop request ends it after a whole frame, so the cursor is where stop_anim expects it.
animate() {
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  i=0; stop=0
  trap 'stop=1' TERM
  while [ "$stop" = 0 ]; do
    # A frame takes about 0.1 s (0.08 s of sleep and the drawing), so 30 make a 3 s cycle: shut for the
    # last two, and on every third cycle also two frames before, open between: a quick double blink.
    n=$((i % 30)); eyes=$ART2
    if [ "$n" -ge 28 ]; then eyes=$ART2_SHUT
    elif [ $((i / 30 % 3)) = 2 ] && [ "$n" -ge 24 ] && [ "$n" -le 25 ]; then eyes=$ART2_SHUT
    fi
    eval "spin=\${$((i % 10 + 1))}"
    printf '\033[4A'
    draw_art "$eyes"
    tagline "$(cat "$tmp/version" 2>/dev/null || true)"
    printf '\r\033[K%s %s' "$spin" "$(cat "$tmp/step" 2>/dev/null || true)"
    i=$((i + 1))
    sleep 0.08
  done
}
start_anim() { [ "$anim" = 1 ] || return 0; animate & anim_pid=$!; }
# Ends the animation where it stands: eyes open, the step line cleared, the cursor shown.
stop_anim() {
  [ -n "$anim_pid" ] || return 0
  kill "$anim_pid" 2>/dev/null || true; wait "$anim_pid" 2>/dev/null || true; anim_pid=''
  printf '\033[4A'; draw_art "$ART2"; tagline "$(cat "$tmp/version" 2>/dev/null || true)"; printf '\r\033[K\033[?25h'
  [ -s "$tmp/said" ] && cat "$tmp/said"
  return 0
}
# A step: on the line under the animated banner, and kept for after; otherwise a line as before.
step() { if [ -n "$anim_pid" ]; then printf '%s' "$*" > "$tmp/step"; say "$*" >> "$tmp/said"; else say "$*"; fi; }

command -v git >/dev/null 2>&1 || die "git is required (xcode-select --install on macOS)"
command -v node >/dev/null 2>&1 || die "Node 22 or newer is required: https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] 2>/dev/null || die "Node 22 or newer is required; found $(node --version)"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/angelia-install.XXXXXX")
trap 'stop_anim; rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# While the banner moves, what the tools write goes to a log, shown if a step fails.
quiet() { if [ -n "$anim_pid" ]; then "$@" 2>>"$tmp/log"; else "$@"; fi; }
# The same for a step whose normal output is not needed either: any line it prints would break the frame.
hush() { if [ -n "$anim_pid" ]; then "$@" >>"$tmp/log" 2>&1; else "$@"; fi; }
banner
start_anim
step "finding the newest release"

# The newest vX.Y.Z tag, or ANGELIA_REF when set (a tag or a branch, for testing a fork).
ref="${ANGELIA_REF:-$(quiet git ls-remote --tags --refs "$REPO" 'v*' | sed 's|.*refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)}"
[ -n "$ref" ] || die "no release tag in $REPO yet (set ANGELIA_REF=main to install the branch tip)"
printf '%s' "${ref#v}" > "$tmp/version"
step "fetching $REPO at $ref"
quiet git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "$REPO" "$tmp/src" || die "could not fetch $ref from $REPO"
if [ "$(git -C "$tmp/src" cat-file -t "refs/tags/$ref" 2>/dev/null || true)" = tag ]; then
  [ -n "$SIGNERS" ] || die "this installer carries no release key, so $ref cannot be checked. Nothing was installed."
  printf '%s\n' "$SIGNERS" > "$tmp/allowed_signers"
  git -C "$tmp/src" -c gpg.ssh.allowedSignersFile="$tmp/allowed_signers" verify-tag "$ref" >/dev/null 2>&1 \
    || die "$ref is not signed by the Angelia release key. Nothing was installed."
  [ "$(git -C "$tmp/src" cat-file tag "$ref" | sed -n 's/^tag //p' | head -1)" = "$ref" ] \
    || die "$ref is a signed tag of another release under a new name. Nothing was installed."
  step "$ref: signature checked"
elif [ -n "${ANGELIA_REF:-}" ]; then
  step "$ref is not a release tag: installing it unsigned"
else
  die "$ref is not a signed release tag. Nothing was installed."
fi
step "building"
hush sh -c 'cd "$1" && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent build && npm pack --ignore-scripts --silent --pack-destination "$2" >/dev/null' sh "$tmp/src" "$tmp" || die "the build failed"
tgz=$(ls "$tmp"/*.tgz | head -1)
[ -n "$tgz" ] || die "npm pack produced no tarball"
step "installing"
hush npm i -g --ignore-scripts --no-audit --no-fund --silent "$tgz" || die "npm could not install it"
stop_anim
command -v angelia >/dev/null 2>&1 || die "installed, but 'angelia' is not on PATH; add $(npm prefix -g)/bin to PATH"
say "installed angelia $(node -e "console.log(require('$(npm root -g)/angelia-gateway/dist/build.json').commit.slice(0,7))" 2>/dev/null || true)"

if [ -e "$STATE/workspace/routing.yaml" ]; then
  say "an instance already exists at $STATE; left as it is. The running daemon keeps the old code until: angelia restart (or /restart in a chat)."
  exit 0
fi
# exec replaces this shell, so the EXIT trap would never run. init does not draw the banner again.
rm -rf "$tmp"; trap - EXIT
if [ "$tty" = 1 ]; then export ANGELIA_BANNER_SHOWN=1; fi
# Under `curl … | sh` stdin is the pipe; the terminal is still there as /dev/tty.
if [ -t 0 ]; then
  exec angelia init
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  exec angelia init </dev/tty >/dev/tty
else
  say "no terminal attached, so setup was not started. Run: angelia init"
fi
