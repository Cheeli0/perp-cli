import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "fs";
import { resolve } from "path";
import { PerpError } from "../errors.js";

/** How long to wait for another process's lock, and when a lock left by a dead process is stale. */
export const FILE_LOCK_WAIT_MS = 5_000;
export const FILE_LOCK_STALE_MS = 30_000;

/** Locks this process holds (path → depth): a nested load-modify-save in the same process never self-deadlocks. */
const held = new Map<string, number>();

/**
 * Run `fn` holding the advisory lock file `<path>.lock` (O_EXCL create) — for a load → modify →
 * save of a state file shared by several perp processes (bots, daemons, CLI), so one process
 * never overwrites another's concurrent write. A lock older than FILE_LOCK_STALE_MS (its holder
 * died) is removed; a live one not released within FILE_LOCK_WAIT_MS → LOCK_HELD (nothing is
 * written on top of an unknown concurrent write).
 */
export function withFileLock<T>(path: string, what: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const depth = held.get(lock) ?? 0;
  if (depth > 0) {
    held.set(lock, depth + 1);
    try { return fn(); } finally { held.set(lock, depth); }
  }
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > FILE_LOCK_STALE_MS;
      } catch {
        continue; // released between the open and the stat: try again
      }
      if (stale) {
        try { unlinkSync(lock); } catch { /* another process removed it */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new PerpError("LOCK_HELD", `${what} is locked by another perp process (${lock})`, {
          remediation: `Retry shortly; if no other perp process is running, delete ${lock}`,
        });
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  held.set(lock, 1);
  try {
    return fn();
  } finally {
    held.delete(lock);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}
