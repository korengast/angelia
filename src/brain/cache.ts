import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** A sandboxed profile's own cache folder, in the state folder: named by a hash of the profile, so
 *  any name makes a safe folder name and two names never share one. */
export function profileCacheDir(stateDir: string, backend: 'codex' | 'pi', profileName: string): string {
  return join(stateDir, 'cache', backend, createHash('sha256').update(profileName).digest('hex').slice(0, 16));
}

/** Caches the common tools write into the home folder, moved into the profile's own cache folder
 *  (npm's error would otherwise advise `sudo chown`; ~/.npm/_npx holds code run later outside).
 *  The folders are made here: a tool inside the sandbox may not make them. */
export function cacheEnv(dir: string): NodeJS.ProcessEnv {
  const env = { npm_config_cache: join(dir, 'npm'), UV_CACHE_DIR: join(dir, 'uv'), PIP_CACHE_DIR: join(dir, 'pip'), XDG_CACHE_HOME: join(dir, 'xdg') };
  for (const d of Object.values(env)) { try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* the tool makes it */ } }
  return env;
}
