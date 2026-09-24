# ADR 0009 — Ship Baileys built and bundled; never build a dependency at install time

Status: accepted 2026-09-21.

## The failure

`npm pack`, then `npm i -g --prefix <empty dir> angelia-0.0.1.tgz`, failed. Angelia depends on a
fork of Baileys (`doryani-ai/Baileys`, a companion-registration fix not yet upstream), referenced
as a git URL. For a git dependency npm clones the repo and runs its `prepare` script, which here is
a full TypeScript build. In npm's clone that build does not compile:
`src/WAM/encode.ts(155,34): Cannot find name 'Buffer'`. The fork is a yarn project and its build
assumes its own dev setup.

It went unnoticed because every earlier check ran inside the checkout, whose `node_modules` had
been built long before from the lockfile. A tarball carries no lockfile. One check (2026-09-20)
even installed the dependency by itself, but with `--ignore-scripts`, which skips the exact step
that fails. It proved nothing.

## Options

1. **Publish the fork to npm.** Clean for users, but it puts a package under someone's npm account
   and a release process on a fork we do not own. Not ours to do unilaterally.
2. **Depend on a tarball of a built GitHub release.** The fork has no releases, and we cannot cut
   them.
3. **Vendor a built tarball and depend on it with `file:`.** Tried and measured: npm resolves a
   `file:` dependency of a packed package relative to the install location *before* extracting
   it, so the path never exists. `ENOENT …/node_modules/angelia/vendor/…tgz`. Dead end.
4. **Bundle it.** Build the fork once at the pinned commit, keep the packed result in `vendor/`,
   install it into the checkout from there, and list `baileys` in `bundleDependencies`. `npm pack`
   then puts the installed, already-built copy inside Angelia's own tarball, and an install uses
   that copy without resolving or building anything.

## Decision

Option 4.

- `vendor/baileys-7.0.0-rc14-4f263f0.tgz` — the fork at `4f263f0e365c2e74dd1b824031d1c5910f518c26`,
  built with its own dev dependencies and packed with `npm pack --ignore-scripts`.
  sha256 `2c4c49e08102cfff3367356008a34d692cf86ac2c6b4bd16526c87a5780dfa62`.
- `"baileys": "file:vendor/baileys-7.0.0-rc14-4f263f0.tgz"` and `"bundleDependencies": ["baileys"]`.
  The `file:` spec is only ever read in the checkout; a packed install never looks at it.
- `tests/slow/package.test.ts` is the gate: pack, install globally into an empty prefix with an empty
  npm cache and SSH disabled, then run the installed `angelia --help`, `check-config` on a sample
  table, both voice scripts, `send`, `send-media` and `restart`.

## Consequences

- The tarball grows from 85 kB to about 5.8 MB, because bundling carries Baileys' own dependency
  tree (60 packages, all plain JavaScript — no native binaries, so it is portable).
- An install needs no git, no SSH key, no build tools, and no network access to GitHub. It still
  needs the npm registry for Angelia's other dependencies.
- Updating Baileys is now a deliberate step: clone the fork at the new commit, `npm install
  --ignore-scripts && npm run build`, `npm pack --ignore-scripts`, replace the file in `vendor/`,
  update the name, the hash here and `package.json`, `npm install`, run the suite.
- The fork can now be deleted upstream without breaking installs. That was a risk before.
- When the fix lands in upstream Baileys on npm, this ADR is superseded by a plain registry
  dependency and `vendor/` goes away.

## Checking the vendored copy against its source

The tarball's `package.json` has no `gitHead`, so nothing inside it names the commit it came from;
this ADR does. To check it, rebuild it and compare the files, not the tarball's hash (tar headers
carry times and owners):

```sh
git clone https://github.com/doryani-ai/Baileys /tmp/b && cd /tmp/b
git checkout 4f263f0e365c2e74dd1b824031d1c5910f518c26
corepack enable && yarn install --immutable && yarn build   # the fork pins yarn 4.9.2
npm pack --ignore-scripts --pack-destination /tmp
mkdir /tmp/ours /tmp/theirs
tar -xzf <angelia>/vendor/baileys-7.0.0-rc14-4f263f0.tgz -C /tmp/ours
tar -xzf /tmp/baileys-7.0.0-rc14.tgz -C /tmp/theirs
diff -r /tmp/ours/package /tmp/theirs/package && echo same
```

A difference in `lib/` means the build is not reproducible from that commit (a different
TypeScript, say) or the vendored copy is not what this ADR says; either way, find out before the
next release.

Its one compiled dependency, `whatsapp-rust-bridge` (WebAssembly that does WhatsApp's crypto), is
not the fork's choice: upstream Baileys 7.0.0-rc14 pins the same `0.5.4`. It comes from the npm
registry at the integrity hash in `package-lock.json`, and one maintainer publishes it; its
source is `github.com/jlucaso1/whatsapp-rust-bridge`. Treat a bump of it as a review of that
source, not a routine update.

## Found on the way

The same test caught a second, silent bug. `transcribe.mjs` and `speak.mjs` decided whether to run
by comparing `import.meta.url` to `file://` + `argv[1]` as strings. Launched through a symlink — an
npm-linked or globally installed copy, or any path under `/tmp` or `/var` on macOS — the strings
differ, `main()` was skipped, and the script exited 0 having done nothing. They now compare real
paths.
