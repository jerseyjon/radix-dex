// File helpers of the OwnerPool bot and watcher: the lock, durable state saves, the heartbeat.
// Node only: NOT exported from index.ts (the core package is also used in the browser). Import it
// directly: `../packages/core/src/ownerpool-files.ts`.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { lockVerdict, type Heartbeat } from './ownerpool-guard.ts';

/** Whether `pid` is alive and running `program` (Linux /proc; elsewhere only "alive"). */
export function pidRuns(pid: number, program: string): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return !program || cmd.includes(program);
  } catch { return true; }
}

/**
 * Take the lock atomically (O_EXCL). An existing lock whose holder is gone (or is another program now:
 * PID reuse) is removed and the take retried once. Returns a release function, or throws with the holder.
 * The release runs on process exit too, and only removes the lock while it is still ours.
 */
export function acquireLock(path: string, program: string, alive: (pid: number, program: string) => boolean = pidRuns): { release: () => void; replacedStale?: string } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n${program}\n${new Date().toISOString()}\n`;
  let replacedStale: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      const release = () => {
        try { if (readFileSync(path, 'utf8') === content) unlinkSync(path); } catch { /* gone */ }
      };
      process.once('exit', release);
      return { release, replacedStale };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let existing: string | undefined;
      try { existing = readFileSync(path, 'utf8'); } catch { existing = undefined; }
      const v = lockVerdict(existing, alive, process.pid);
      if (!v.stale) throw new Error(`another ${program} holds ${path}: ${v.reason}`);
      replacedStale = v.reason;
      try { unlinkSync(path); } catch { /* raced: retry */ }
    }
  }
  throw new Error(`could not take ${path}`);
}

/** Write `data` as JSON durably: temp file, fsync, keep the previous file as `.bak`, rename, fsync the directory. */
export function saveJsonDurable(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(data, null, 1) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(path)) { try { copyFileSync(path, `${path}.bak`); } catch { /* best effort */ } }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not every fs allows it */ }
}

/**
 * Read a JSON state file. Missing: undefined. Corrupt: the `.bak` if it parses (reported in
 * `recovered`), else throws (the caller alerts and refuses to start).
 */
export function loadJsonWithBackup<T>(path: string): { data?: T; recovered?: string } {
  if (!existsSync(path)) return {};
  try { return { data: JSON.parse(readFileSync(path, 'utf8')) as T }; } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 160);
    const bak = `${path}.bak`;
    if (existsSync(bak)) {
      try { return { data: JSON.parse(readFileSync(bak, 'utf8')) as T, recovered: `${path} is corrupt (${why}); loaded ${bak}` }; } catch { /* both bad */ }
    }
    throw new Error(`state file ${path} is corrupt (${why}) and has no usable .bak`);
  }
}

/** Write the heartbeat (small, atomic rename; no fsync: losing one beat to a power cut is fine). */
export function writeHeartbeat(path: string, b: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(b) + '\n'); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
