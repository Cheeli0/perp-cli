/**
 * Fixture scrub (plan ws-0.14.4 §3 M8, Phase 0): committed WS fixtures must not carry the real
 * account's identifiers, ids, hashes or any credential.
 *
 * Only the dummies are hard-coded here. The test needs no knowledge of the real ids: it asserts that
 * every identifier-shaped value in the fixtures IS one of the dummies, so a real address / account id
 * cannot be present. (scripts/ws-probe/make-fixtures.ts additionally checks the real ids before writing.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(import.meta.dirname, "../fixtures/ws");
const DUMMY_EVM = new Set(["0x000000000000000000000000000000000000dead", "0x000000000000000000000000000000000000beef"]);
const DUMMY_SOLANA = "DummyPacificaAccount111111111111111111111111";
const DUMMY_LIGHTER_ACCOUNTS = new Set(["1000001", "1000002"]);
const DUMMY_HASH = /^0x(d0){28}[0-9a-f]{8}$/;
const SECRET_KEY = /^(auth|token|authToken|listenKey|signature|sig|hmac|apiKey|api_key|secret|privateKey|private_key)$/i;
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".json") ? [p] : [];
  });
}

function walk(j: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  visit(key, j);
  if (Array.isArray(j)) j.forEach(x => walk(x, visit, key));
  else if (j !== null && typeof j === "object") for (const [k, v] of Object.entries(j)) { visit(k, k); walk(v, visit, k); }
}

const all = files(DIR).map(path => ({ path, rel: path.slice(DIR.length + 1), json: JSON.parse(readFileSync(path, "utf8")) as { kind: string; frames: unknown[] } }));
const priv = all.filter(f => f.json.kind === "private");

describe("WS fixture scrub", () => {
  it("has fixtures for every 0.14.4 venue, public and private", () => {
    const venues = new Set(all.map(f => f.rel.split("/")[0]));
    for (const v of ["hyperliquid", "pacifica", "lighter", "lighter-rh", "aster", "arcus"]) expect(venues.has(v)).toBe(true);
    for (const v of ["hyperliquid", "pacifica", "lighter", "lighter-rh", "arcus"]) {
      expect(priv.some(f => f.rel.startsWith(`${v}/`))).toBe(true);
    }
  });

  it.each(all.map(f => [f.rel, f] as const))("%s: no credential fields", (_rel, f) => {
    walk(f.json, (k) => expect(SECRET_KEY.test(k), `secret-like key "${k}"`).toBe(false));
  });

  it.each(all.map(f => [f.rel, f] as const))("%s: every EVM address is a dummy", (_rel, f) => {
    const text = JSON.stringify(f.json);
    for (const m of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) {
      expect(DUMMY_EVM.has(m.toLowerCase()), `address ${m.slice(0, 6)}… is not a dummy`).toBe(true);
    }
  });

  it.each(priv.map(f => [f.rel, f] as const))("%s: private ids, hashes and accounts are dummies", (_rel, f) => {
    const text = JSON.stringify(f.json);
    for (const m of text.match(/0x[0-9a-fA-F]{64}/g) ?? []) expect(DUMMY_HASH.test(m), `hash ${m.slice(0, 6)}…`).toBe(true);
    for (const m of text.matchAll(/(user_stats|account_all_[a-z_]+)[:/](\d+)/g)) {
      expect(DUMMY_LIGHTER_ACCOUNTS.has(m[2] ?? ""), `lighter account in ${m[1]}`).toBe(true);
    }
    walk(f.json, (k, v) => {
      if (typeof v === "string" && BASE58_ID.test(v)) expect(v, `base58 id under "${k}"`).toBe(DUMMY_SOLANA);
      if ((k === "account_index" || k === "accountIndex") && typeof v === "number" && v > 1000) {
        expect(DUMMY_LIGHTER_ACCOUNTS.has(String(v)), `account index under "${k}"`).toBe(true);
      }
    });
    const hasDummy = text.toLowerCase().includes("0x000000000000000000000000000000000000dead")
      || text.includes(DUMMY_SOLANA) || [...DUMMY_LIGHTER_ACCOUNTS].some(d => text.includes(d));
    expect(hasDummy, "private fixture shows no sign of anonymization").toBe(true);
  });
});
