import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './daemon.js';

/**
 * `angelia update`: replace the installed package with the newest signed release of its source, and
 * say what changed. The instance is out of reach by construction: the source is cloned and built in
 * a temp folder, and the only write outside it is `npm i -g` of the packed tarball, into npm's global
 * folder. That is the same path as a first install, so an update cannot drift from it.
 *
 * What it installs is checked three ways before anything is built:
 * - a release is a tag `vX.Y.Z` signed by a key in the **installed** copy's `allowed_signers`, never
 *   the one that came with the download, so a changed account cannot ship a tag this copy accepts
 *   (a copy with no keys refuses; install.sh checks the first install against the key it carries);
 * - the installed commit must be in the new one's history, so a rewritten or older source is not
 *   taken for an update (`--force` overrides this one, and only this one);
 * - no dependency runs an install script: `npm ci --ignore-scripts`, then this package's own build;
 *   the tarball carries every dependency at its locked version, so the install resolves nothing.
 * `--head` installs the branch tip instead, unsigned, and says so: that is for development.
 *
 * It never restarts anything. The running daemon keeps the code it loaded; the user restarts when
 * it suits them, from a chat (/restart) or a terminal.
 */

/** The installed package's root: dist/daemon/update.js lives two levels down. */
export function packageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export interface Build { commit: string | null; dirty?: boolean; built?: string; tag?: string }

/** The build stamp, or undefined when the copy has none. A stamp that cannot be read is an error, not
 *  "no stamp": with no installed commit the ancestry check has nothing to check, and would pass. */
export function readBuild(root = packageRoot()): Build | undefined {
  const file = join(root, 'dist', 'build.json');
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  try { return JSON.parse(text) as Build; } catch { throw new Error(`${file} is not valid JSON, so the installed commit is unknown. Reinstall with install.sh.`); }
}

/** This package's npm name, which is also its folder under npm's global root. */
export function packageName(root = packageRoot()): string {
  try { return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }).name ?? 'angelia-gateway'; } catch { return 'angelia-gateway'; }
}

/** The git URL in package.json, without npm's `git+` prefix. */
export function defaultSource(root = packageRoot()): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { repository?: string | { url?: string } };
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    return url?.replace(/^git\+/, '');
  } catch { return undefined; }
}

/**
 * Why this copy must not be updated this way, if it must not. A checkout (tsx, npm link) is updated
 * with git; replacing a linked global install would cut the link and silently swap a dev tree for a
 * release. A global folder inside the instance would put npm's writes where the user's content is.
 */
export function refusal(root: string, globalRoot: string, stateDir = STATE_DIR, name = packageName(root)): string | undefined {
  if (existsSync(join(root, '.git'))) return `this angelia runs from a checkout (${root}). Update it with git pull and npm run build.`;
  const installed = join(globalRoot, name);
  try {
    if (lstatSync(installed).isSymbolicLink()) return `the global angelia is a link to a checkout (${installed}). Update the checkout with git, or npm unlink it first.`;
  } catch {}
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
  if (inside(resolve(globalRoot), resolve(stateDir))) return `npm's global folder (${globalRoot}) is inside the instance (${stateDir}); refusing to write there.`;
  return undefined;
}

/** Release tags (`v1.2.3`), newest first. Anything else is not a release. */
export function releaseTags(tags: string[]): string[] {
  const parts = (t: string) => t.slice(1).split('.').map(Number);
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => {
    const x = parts(a), y = parts(b);
    for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return y[k] - x[k];
    return 0;
  });
}

/** A copy's release keys (`allowed_signers` at its root), when it has them. */
export function signersFile(root: string): string | undefined {
  const f = join(root, 'allowed_signers');
  return existsSync(f) ? f : undefined;
}

/** Undefined when `tag` in `repo` is signed by a key in `signers` and names itself; otherwise the
 *  reason. The name inside the tag object is checked too: a genuine old tag object under a new ref
 *  (`v99.0.0` pointing at `v0.1.0`) would otherwise verify and be taken as the newest release. */
export function verifyTag(repo: string, tag: string, signers: string): string | undefined {
  const r = spawnSync('git', ['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-tag', tag], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop() ?? `git verify-tag ${tag} failed`;
  const named = /^tag (.+)$/m.exec(spawnSync('git', ['cat-file', 'tag', tag], { cwd: repo, encoding: 'utf8' }).stdout ?? '')?.[1];
  return named === tag ? undefined : `the signed tag object is named ${named ?? 'nothing'}, not ${tag}`;
}

export interface Target { commit: string; tag?: string; notes: string[] }

/**
 * Put the clone at what should be installed and say why it may be. A release: the newest `vX.Y.Z`,
 * checked out and verified. `--head`: the branch tip as cloned. Throws, with nothing installed, when
 * there is no release or its signature is not one the installed copy trusts.
 */
export function chooseTarget(src: string, installedRoot: string, head: boolean): Target {
  if (head) return { commit: run('git', ['rev-parse', 'HEAD'], src), notes: ['--head: the branch tip, not a signed release.'] };
  const tag = releaseTags(run('git', ['tag', '--list', 'v*'], src).split('\n'))[0];
  if (!tag) throw new Error('the source has no release tag (v1.2.3) yet. angelia update --head installs its branch tip, unsigned.');
  run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag], src);
  // No keys here means no way to check, never "trust the keys the download brings": whoever controls
  // the repository that day would choose them. Every public copy has keys; reinstall one that has not.
  const signers = signersFile(installedRoot);
  if (!signers) throw new Error(`${tag} cannot be checked: the installed copy has no release keys (allowed_signers). Nothing was installed. Reinstall with install.sh, or use --head for the unsigned branch tip.`);
  const bad = verifyTag(src, tag, signers);
  if (bad) throw new Error(`${tag} is not a release this copy trusts (${bad}). Nothing was installed.`);
  return { commit: run('git', ['rev-parse', 'HEAD'], src), tag, notes: [`${tag}: signature checked.`] };
}

/**
 * The commits the update brings, or undefined when the installed commit is not in the target's
 * history. That means the source was rewritten, or is older than what is installed: refused unless
 * `force`, because a moved branch or tag must not pass for an update.
 */
export function newCommits(src: string, installed: Build | undefined, target: string, force: boolean): string[] | undefined {
  if (!installed?.commit) return run('git', ['log', '--oneline', '--no-merges', '-10', target], src).split('\n').filter(Boolean);
  try { run('git', ['merge-base', '--is-ancestor', installed.commit, target], src); }
  catch {
    if (!force) throw new Error(`the installed copy (${installed.commit.slice(0, 7)}) is not in the history of ${target.slice(0, 7)}: the source was rewritten, or it is older than what is installed. Nothing was installed. angelia update --force installs it anyway.`);
    return undefined;
  }
  return run('git', ['log', '--oneline', '--no-merges', `${installed.commit}..${target}`], src).split('\n').filter(Boolean);
}

/** The lines `update` prints about the commits between the installed build and the new one. */
export function changesText(from: Build | undefined, to: string, log: string[] | undefined): string[] {
  const short = (c: string) => c.slice(0, 7);
  if (!from?.commit) return [`The installed copy has no build stamp, so the exact changes are unknown. Now at ${short(to)}.`, ...(log ?? []).map((l) => `  ${l}`)];
  const lines: string[] = [];
  if (from.dirty) lines.push(`The installed copy was built from ${short(from.commit)} with uncommitted changes.`);
  if (!log) return [...lines, `${short(from.commit)} is not in the source's history (rewritten, or built from elsewhere). Now at ${short(to)}.`];
  return [...lines, `${short(from.commit)} → ${short(to)}, ${log.length} commit${log.length === 1 ? '' : 's'}:`, ...log.map((l) => `  ${l}`)];
}

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const out = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}\n${out}`);
  }
  return (r.stdout ?? '').trim();
}

export async function updateCommand(argv: string[]): Promise<void> {
  const check = argv.includes('--check'), head = argv.includes('--head'), force = argv.includes('--force');
  const fromAt = argv.indexOf('--from');
  let source = fromAt >= 0 ? argv[fromAt + 1] : undefined;
  if (fromAt >= 0 && !source) throw new Error('--from needs a git URL or a folder');
  if (source && !/^[a-z+]+:\/\/|^git@/.test(source)) source = isAbsolute(source) ? source : resolve(source.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  source ??= defaultSource();
  if (!source) throw new Error('no source to update from: package.json has no repository. Pass --from <git URL or folder>.');

  const root = packageRoot();
  const globalRoot = run('npm', ['root', '-g']);
  const no = refusal(root, globalRoot);
  if (no) throw new Error(no);

  const installed = readBuild(root);
  const tmp = mkdtempSync(join(tmpdir(), 'angelia-update-'));
  try {
    const src = join(tmp, 'src');
    console.log(`fetching ${source}`);
    run('git', ['clone', '--quiet', source, src]);
    const name = packageName(src);
    if (name !== packageName(root)) throw new Error(`the source is now the package ${name}, not ${packageName(root)}. Install it once by hand: npm rm -g ${packageName(root)} && npm i -g ${source}`);
    const target = chooseTarget(src, root, head);
    if (installed?.commit === target.commit && !installed.dirty) { console.log(`Already up to date at ${target.tag ?? target.commit.slice(0, 7)}.`); return; }
    const log = newCommits(src, installed, target.commit, force);
    for (const l of [...target.notes, ...changesText(installed, target.commit, log)]) console.log(l);
    if (check) { console.log('--check: nothing installed.'); return; }

    // No dependency's install script runs, here or in the global install: this package's own build
    // is the only code executed before the new copy is in place. None of the dependencies needs one.
    console.log('building');
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], src);
    run('npm', ['run', 'build'], src);
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', tmp], src);
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no tarball');
    console.log('installing');
    run('npm', ['i', '-g', '--ignore-scripts', '--no-audit', '--no-fund', join(tmp, tgz)], tmp);

    const now = readBuild(join(globalRoot, name));
    if (now?.commit !== target.commit) throw new Error(`installed, but the global copy reports ${now?.commit ?? 'no build stamp'}, not ${target.commit}`);
    console.log(`Updated to ${target.tag ? `${target.tag} (${target.commit.slice(0, 7)})` : target.commit.slice(0, 7)}. The instance (${STATE_DIR}) was not touched.`);
    console.log('The running daemon still has the old code: send /restart in a chat, or run angelia restart.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
