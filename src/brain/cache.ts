import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** A sandboxed profile's own cache folder, in the state folder: named by a hash of the profile, so
 *  any name makes a safe folder name and two names never share one. */
export function profileCacheDir(stateDir: string, backend: 'codex' | 'pi' | 'agy', profileName: string): string {
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

/** An agy profile's own `--gemini-dir` (settings, MCP config, conversations), in the state folder,
 *  named like profileCacheDir. Made private to its owner here. */
export function agyGeminiDir(stateDir: string, profileName: string): string {
  const dir = agyGeminiPath(stateDir, profileName);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Where agyGeminiDir puts a profile's folder, without making it (compile, the launch check). */
export function agyGeminiPath(stateDir: string, profileName: string): string {
  return join(stateDir, 'agy', createHash('sha256').update(profileName).digest('hex').slice(0, 16));
}
