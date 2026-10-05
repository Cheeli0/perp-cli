/**
 * Position quarantine (design §12.3) — GLOBAL per symbol.
 *
 * A spot leg whose outcome is unknown (ORDER_PENDING), a perp leg that could not be
 * confirmed, a close whose post-trade verification failed, or a position left unhedged
 * by a failed rollback must NOT be retried automatically: a retry can double-buy,
 * double-sell or open a naked perp. Such a symbol is quarantined here, persisted in
 * ~/.perp/bot-quarantine.json, and skipped by EVERY automated path — the bot strategies
 * (funding-arb, funding-arb-v2, spot-perp-arb, funding-auto), `perp arb exec` (perp-perp
 * and spot:<venue>) and the `perp arb auto` / `arb dex-auto` daemons — no entry, no close,
 * no rotation — until a human clears it (`perp arb close` refuses it without --force):
 *
 *   perp strategy quarantine                       # list
 *   perp strategy quarantine-clear <symbol> [--strategy <source>]
 *
 * Entries are stored per source ("<source>:<KEY>", source = strategy name or CLI path)
 * but CHECKED by the canonical key alone (quarantineKey: HIP-3 dex prefix and "-PERP"
 * stripped, DENOMINATION_ALIASES applied, uppercased — "xyz:TSLA" ≡ "TSLA", "KPEPE" ≡
 * "1000PEPE"): one venue's unknown outcome blocks the underlying for all strategies,
 * venues and processes. `entry.symbol` keeps the symbol as the source reported it. The file is re-read on every check, so a clear
 * from the CLI takes effect in running bots on their next tick (no restart). Only an
 * entry whose persist failed is held in process memory (logged CRITICAL); it holds
 * until that process stops.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { PerpError } from "../errors.js";
import { DENOMINATION_ALIASES } from "../exchanges/canonical-symbols.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
export const QUARANTINE_FILE = resolve(PERP_DIR, "bot-quarantine.json");

export interface QuarantineEntry {
  /** Who quarantined it: a strategy name or a CLI path ("arb-exec"). */
  strategy: string;
  /** The symbol as the source reported it (display); matched via quarantineKey(). */
  symbol: string;
  /** What happened (the CRITICAL log line). */
  reason: string;
  /** What the human must check before clearing. */
  remediation: string;
  time: string; // ISO
}

interface QuarantineFile {
  version: 1;
  entries: Record<string, QuarantineEntry>;
}

/** Entries whose persist failed, by "<source>:<KEY>" (this process only). */
const unpersisted = new Map<string, QuarantineEntry>();

/**
 * Canonical quarantine key for a symbol — the ONLY way a symbol is compared here (set,
 * check, clear): uppercased, HIP-3 dex prefix ("xyz:") and "-PERP" suffix stripped,
 * DENOMINATION_ALIASES applied (KPEPE → 1000PEPE, UBTC → BTC).
 */
export function quarantineKey(symbol: string): string {
  let up = symbol.trim().toUpperCase();
  const colon = up.lastIndexOf(":");
  if (colon >= 0) up = up.slice(colon + 1);
  up = up.replace(/-PERP$/, "");
  return DENOMINATION_ALIASES[up] ?? up;
}

function keyOf(source: string, symbol: string): string {
  return `${source}:${quarantineKey(symbol)}`;
}

/** Read the file. A missing file = nothing quarantined; an unreadable / malformed file throws (never "empty"). */
function load(): QuarantineFile {
  if (!existsSync(QUARANTINE_FILE)) return { version: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(QUARANTINE_FILE, "utf-8"));
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Bot quarantine file is unreadable: ${QUARANTINE_FILE} (${e instanceof Error ? e.message : String(e)})`, {
      remediation: `Fix or remove ${QUARANTINE_FILE} after verifying every quarantined position on the venues`,
    });
  }
  const f = parsed as Partial<QuarantineFile> | null;
  if (f === null || f.version !== 1 || typeof f.entries !== "object" || f.entries === null) {
    throw new PerpError("INVALID_PARAMS", `Bot quarantine file has an unexpected shape: ${QUARANTINE_FILE}`, {
      remediation: `Fix or remove ${QUARANTINE_FILE} after verifying every quarantined position on the venues`,
    });
  }
  return f as QuarantineFile;
}

function save(f: QuarantineFile): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  const tmp = QUARANTINE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  renameSync(tmp, QUARANTINE_FILE);
}

/**
 * Quarantine `symbol` (for every strategy / CLI path) and log CRITICAL with the
 * remediation. `source` records who did it. If persisting fails the entry is held in
 * this process's memory and the failure is logged loudly.
 */
export function quarantineSymbol(
  source: string,
  symbol: string,
  reason: string,
  remediation: string,
  log: (msg: string) => void,
): void {
  const sym = symbol.toUpperCase();
  const key = quarantineKey(sym);
  const entry: QuarantineEntry = { strategy: source, symbol: sym, reason, remediation, time: new Date().toISOString() };
  log(`  [QUARANTINE] CRITICAL: ${sym}${key !== sym ? ` (key ${key})` : ""} quarantined by ${source} — ${reason}`);
  log(`  [QUARANTINE] Remediation: ${remediation}`);
  log(`  [QUARANTINE] No bot / arb path will touch ${key} until cleared: perp strategy quarantine-clear ${key}`);
  try {
    const f = load();
    f.entries[keyOf(source, sym)] = entry;
    save(f);
  } catch (e) {
    unpersisted.set(keyOf(source, sym), entry);
    log(`  [QUARANTINE] CRITICAL: could not persist quarantine to ${QUARANTINE_FILE} (${e instanceof Error ? e.message : String(e)}) — it holds only until this process stops`);
  }
}

/**
 * The quarantine entry blocking `symbol` (any source), or null. Re-reads the file on
 * every call. An unreadable quarantine file fails CLOSED (a synthetic entry, logged) —
 * never "not quarantined".
 */
export function quarantineEntryFor(symbol: string, log: (msg: string) => void): QuarantineEntry | null {
  const sym = symbol.toUpperCase();
  const key = quarantineKey(sym);
  for (const e of unpersisted.values()) if (quarantineKey(e.symbol) === key) return e;
  try {
    for (const e of Object.values(load().entries)) if (quarantineKey(e.symbol) === key) return e;
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  [QUARANTINE] CRITICAL: ${msg} — treating ${sym} as quarantined`);
    return { strategy: "quarantine-file", symbol: sym, reason: msg, remediation: `Fix or remove ${QUARANTINE_FILE}`, time: new Date().toISOString() };
  }
}

/** true when `symbol` is quarantined by any strategy / CLI path (see quarantineEntryFor). */
export function isQuarantined(symbol: string, log: (msg: string) => void): boolean {
  return quarantineEntryFor(symbol, log) !== null;
}

export function listQuarantine(): QuarantineEntry[] {
  return [...Object.values(load().entries), ...unpersisted.values()];
}

/** Remove entries whose quarantineKey matches symbol's (one source, or every source when null). Returns the removed entries. */
export function clearQuarantine(symbol: string, strategy: string | null): QuarantineEntry[] {
  const f = load();
  const key = quarantineKey(symbol);
  const removed: QuarantineEntry[] = [];
  for (const [k, e] of Object.entries(f.entries)) {
    if (quarantineKey(e.symbol) === key && (strategy === null || e.strategy === strategy)) {
      removed.push(e);
      delete f.entries[k];
    }
  }
  for (const [k, e] of unpersisted) {
    if (quarantineKey(e.symbol) === key && (strategy === null || e.strategy === strategy)) {
      removed.push(e);
      unpersisted.delete(k);
    }
  }
  if (removed.length > 0) save(f);
  return removed;
}
