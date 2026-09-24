#!/bin/sh
# Angelia installer: curl -fsSL https://raw.githubusercontent.com/korengast/angelia/<release tag>/install.sh | sh
#
# Does three things and nothing else: checks Node 22+, installs the newest release the way
# `angelia update` does (clone the tag, build, pack, npm i -g, no dependency install scripts), then
# runs `angelia init` unless an instance already exists. It never clones into your home, never
# builds in place, and never touches an existing instance.
#
# The release it installs must be a tag signed by the release key below, and the tag must name
# itself: a new tag pushed by anyone without the key is refused. Fetch this script from a tag (the
# README's line does), so the key it carries is the one that release shipped. The same key is in
# allowed_signers, which the installed copy keeps: `angelia update` checks every later release
# against it. ANGELIA_REF set to a branch installs that branch unsigned, and says so.
set -eu

# One line per key, the format of git's gpg.ssh.allowedSignersFile. Kept equal to allowed_signers by a test.
SIGNERS='korengast@users.noreply.github.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK9Krso/DJH0yfzU2ACgmKYZtCBs4OOeVEX6+KONrUJk'

REPO="${ANGELIA_REPO:-https://github.com/korengast/angelia.git}"
STATE="${ANGELIA_STATE_DIR:-$HOME/.angelia}"

say() { printf '%s\n' "$*"; }
die() { say "install: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required (xcode-select --install on macOS)"
command -v node >/dev/null 2>&1 || die "Node 22 or newer is required: https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] 2>/dev/null || die "Node 22 or newer is required; found $(node --version)"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/angelia-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# The newest vX.Y.Z tag, or ANGELIA_REF when set (a tag or a branch, for testing a fork).
ref="${ANGELIA_REF:-$(git ls-remote --tags --refs "$REPO" 'v*' | sed 's|.*refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)}"
[ -n "$ref" ] || die "no release tag in $REPO yet (set ANGELIA_REF=main to install the branch tip)"
say "fetching $REPO at $ref"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "$REPO" "$tmp/src"
if [ "$(git -C "$tmp/src" cat-file -t "refs/tags/$ref" 2>/dev/null || true)" = tag ]; then
  [ -n "$SIGNERS" ] || die "this installer carries no release key, so $ref cannot be checked. Nothing was installed."
  printf '%s\n' "$SIGNERS" > "$tmp/allowed_signers"
  git -C "$tmp/src" -c gpg.ssh.allowedSignersFile="$tmp/allowed_signers" verify-tag "$ref" >/dev/null 2>&1 \
    || die "$ref is not signed by the Angelia release key. Nothing was installed."
  [ "$(git -C "$tmp/src" cat-file tag "$ref" | sed -n 's/^tag //p' | head -1)" = "$ref" ] \
    || die "$ref is a signed tag of another release under a new name. Nothing was installed."
  say "$ref: signature checked"
elif [ -n "${ANGELIA_REF:-}" ]; then
  say "$ref is not a release tag: installing it unsigned"
else
  die "$ref is not a signed release tag. Nothing was installed."
fi
say "building"
(cd "$tmp/src" && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent build && npm pack --ignore-scripts --silent --pack-destination "$tmp" >/dev/null)
tgz=$(ls "$tmp"/*.tgz | head -1)
[ -n "$tgz" ] || die "npm pack produced no tarball"
say "installing"
npm i -g --ignore-scripts --no-audit --no-fund --silent "$tgz"
command -v angelia >/dev/null 2>&1 || die "installed, but 'angelia' is not on PATH; add $(npm prefix -g)/bin to PATH"
say "installed angelia $(node -e "console.log(require('$(npm root -g)/angelia-gateway/dist/build.json').commit.slice(0,7))" 2>/dev/null || true)"

if [ -e "$STATE/workspace/routing.yaml" ]; then
  say "an instance already exists at $STATE; left as it is. The running daemon keeps the old code until: angelia restart (or /restart in a chat)."
  exit 0
fi
# exec replaces this shell, so the EXIT trap would never run.
rm -rf "$tmp"; trap - EXIT
# Under `curl … | sh` stdin is the pipe; the terminal is still there as /dev/tty.
if [ -t 0 ]; then
  exec angelia init
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  exec angelia init </dev/tty >/dev/tty
else
  say "no terminal attached, so setup was not started. Run: angelia init"
fi
