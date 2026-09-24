#!/usr/bin/env node
// Writes dist/build.json: the commit this build came from, so `angelia update` can say what changed.
// Runs after tsc in `build` and `prepare`. Outside a git checkout the commit is simply unknown.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const commit = git('rev-parse', 'HEAD');
const dirty = commit ? git('status', '--porcelain', '--untracked-files=no') !== '' : false;
// The release this is, when the commit is exactly a release tag.
const tag = commit ? git('tag', '--points-at', 'HEAD', '--list', 'v*').split('\n').find((t) => /^v\d+\.\d+\.\d+$/.test(t)) : undefined;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/build.json', JSON.stringify({ commit: commit || null, dirty, built: new Date().toISOString(), ...(tag ? { tag } : {}) }, null, 2) + '\n');
