import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { PerpError } from "../errors.js";
import type { Network } from "../exchanges/venue-types.js";
import { withFileLock } from "./file-lock.js";
import { arbStateFilePath } from "./state.js";

/**
 * Pending-entry records of the arb daemons (`arb auto`, `arb auto --hip3`) — PER NETWORK, next to
 * the arb state (`arb-state.json` → `arb-state.pending.json`, testnet → `arb-state.testnet.pending.json`).
 *
 * A record is written BEFORE the first leg of a pair entry and removed once the pair is in the
 * arb state / in memory, or rolled back / quarantined. A record that is still there when a daemon
 * of the same source starts means the previous process died (crash, kill) between two legs: what
 * is open is unknown → the symbol is quarantined (never re-entered, never "flat").
 */
export interface PendingEntry {
  /** Daemon that wrote it: "arb-auto" | "arb-dex-auto". */
  source: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  /** Requested base size per leg. */
  size: string;
  startedAt: string; // ISO
  pid: number;
}

interface PendingFile { version: 1; entries: Record<string, PendingEntry> }

export function pendingEntryFilePath(network: Network): string {
  const state = arbStateFilePath(network);
  return state.endsWith(".json") ? `${state.slice(0, -5)}.pending.json` : `${state}.pending`;
}

function keyOf(source: string, symbol: string): string {
  return `${source}:${symbol.toUpperCase()}`;
}

/** A missing file = no pending entry; an unreadable / malformed one throws (never "none pending"). */
function load(path: string): PendingFile {
  if (!existsSync(path)) return { version: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Arb pending-entry file is unreadable: ${path} (${e instanceof Error ? e.message : String(e)})`, {
      remediation: `Check the symbols it names on the venues (perp arb status), then fix or remove ${path}`,
    });
  }
  const f = parsed as Partial<PendingFile> | null;
  if (f === null || f.version !== 1 || typeof f.entries !== "object" || f.entries === null) {
    throw new PerpError("INVALID_PARAMS", `Arb pending-entry file has an unexpected shape: ${path}`, {
      remediation: `Check the symbols it names on the venues (perp arb status), then fix or remove ${path}`,
    });
  }
  return f as PendingFile;
}

function save(path: string, f: PendingFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function modify<T>(network: Network, fn: (f: PendingFile) => T): T {
  const path = pendingEntryFilePath(network);
  return withFileLock(path, `Arb pending-entry file (${network})`, () => {
    const f = load(path);
    const out = fn(f);
    save(path, f);
    return out;
  });
}

/** Record an entry about to send its first leg. Throws when it cannot be persisted (the caller must not trade). */
export function writePendingEntry(network: Network, e: Omit<PendingEntry, "startedAt" | "pid">): void {
  modify(network, (f) => {
    f.entries[keyOf(e.source, e.symbol)] = { ...e, startedAt: new Date().toISOString(), pid: process.pid };
  });
}

/** The entry's outcome is recorded (state / memory / rollback / quarantine): drop its pending record. */
export function clearPendingEntry(network: Network, source: string, symbol: string): void {
  modify(network, (f) => { delete f.entries[keyOf(source, symbol)]; });
}

function alive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists (another user) — treat as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pending records of `source` left by a process that is no longer running (crashed / killed
 * mid-entry). Read-only: the caller quarantines each one, then clears it (clearPendingEntry).
 * Records of a live process (another daemon still entering) are not returned.
 */
export function orphanedPendingEntries(network: Network, source: string): PendingEntry[] {
  const f = load(pendingEntryFilePath(network));
  return Object.values(f.entries).filter(e => e.source === source && !alive(e.pid));
}
