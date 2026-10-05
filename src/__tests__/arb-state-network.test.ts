/**
 * Review N2 / N3: arb daemon state is per network, the pre-network (untagged) file is adopted
 * as mainnet without loss or duplication, and the dry-run daemon store never writes to disk.
 * HOME is isolated by the vitest setup file; paths are pinned with setStateFilePath.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import {
  addPosition, arbStateFilePath, createDaemonStateStore, createInitialState, getPositions, loadArbState,
  removePosition, saveArbState, setStateFilePath, resetStateFilePath, type ArbPositionState,
} from "../arb-state.js";

const CONFIG = { minSpread: 0, closeSpread: 0, size: 0, holdDays: 0, bridgeCost: 0, maxPositions: 10, settleStrategy: "off" };

function pos(symbol: string, extra: Partial<ArbPositionState> = {}): ArbPositionState {
  return {
    id: `${symbol}-1`, symbol, longExchange: "hyperliquid", shortExchange: "hyperliquid", longSize: 100, shortSize: 100,
    entryTime: "2026-03-17T00:38:25.440Z", entrySpread: 10, entryLongPrice: 0.1, entryShortPrice: 0.1,
    accumulatedFunding: 0, lastCheckTime: "2026-03-17T00:38:25.440Z", ...extra,
  };
}

let dir: string;
let main: string;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "arb-net-"));
  main = join(dir, "arb-state.json");
  setStateFilePath(main);
});
afterEach(() => {
  resetStateFilePath();
  rmSync(dir, { recursive: true, force: true });
});

describe("per-network arb state (N2)", () => {
  it("mainnet keeps the pre-network path; testnet gets its own file", () => {
    expect(arbStateFilePath("mainnet")).toBe(main);
    expect(arbStateFilePath("testnet")).toBe(join(dir, "arb-state.testnet.json"));
  });

  it("a testnet position is invisible to mainnet and vice versa; files are tagged", () => {
    addPosition("mainnet", pos("BTC"));
    addPosition("testnet", pos("ETH"));
    expect(getPositions("mainnet").map(p => p.symbol)).toEqual(["BTC"]);
    expect(getPositions("testnet").map(p => p.symbol)).toEqual(["ETH"]);
    removePosition("testnet", "BTC"); // no-op on testnet — must not touch mainnet's BTC
    expect(getPositions("mainnet").map(p => p.symbol)).toEqual(["BTC"]);
    expect(JSON.parse(readFileSync(main, "utf-8")).network).toBe("mainnet");
    expect(JSON.parse(readFileSync(arbStateFilePath("testnet"), "utf-8")).network).toBe("testnet");
  });

  it("legacy untagged file (real mainnet PURR spot-perp shape): testnet refuses; mainnet adopts it once, tagged, with a backup — no loss, no duplication", () => {
    const legacy = { ...createInitialState(CONFIG), positions: [pos("PURR", { mode: "spot-perp", spotExchange: "hyperliquid", spotSymbol: "PURR/USDC" })] };
    delete (legacy as { network?: string }).network;
    const raw = JSON.stringify(legacy, null, 2);
    writeFileSync(main, raw);

    // Testnet: explicit user action required (never guess, never drop).
    expect(() => loadArbState("testnet")).toThrow(/Untagged arb state/);
    expect(() => addPosition("testnet", pos("ETH"))).toThrow(/Untagged arb state/);
    expect(existsSync(arbStateFilePath("testnet"))).toBe(false);
    expect(readFileSync(main, "utf-8")).toBe(raw); // untouched by the refused testnet calls

    // Mainnet: adopted as mainnet.
    const st = loadArbState("mainnet")!;
    expect(st.network).toBe("mainnet");
    expect(st.positions).toHaveLength(1);
    expect(st.positions[0]).toMatchObject({ symbol: "PURR", mode: "spot-perp", longSize: 100 });
    expect(readFileSync(`${main}.pre-network.bak`, "utf-8")).toBe(raw);
    expect(JSON.parse(readFileSync(main, "utf-8"))).toEqual({ ...legacy, network: "mainnet" });

    // Afterwards testnet works and starts empty (the PURR position is NOT copied there).
    expect(loadArbState("testnet")).toBeNull();
    expect(getPositions("testnet")).toEqual([]);
    expect(getPositions("mainnet").map(p => p.symbol)).toEqual(["PURR"]);
  });

  it("a file tagged for the other network is refused", () => {
    writeFileSync(arbStateFilePath("testnet"), JSON.stringify({ ...createInitialState(CONFIG), network: "mainnet" }));
    expect(() => loadArbState("testnet")).toThrow(/tagged mainnet, not testnet/);
  });

  it("saving a state object loaded for one network onto the other is refused", () => {
    addPosition("mainnet", pos("BTC"));
    const m = loadArbState("mainnet")!;
    expect(() => saveArbState("testnet", m)).toThrow(/Refusing to save mainnet arb state as testnet/);
  });
});

describe("dry-run daemon store (N3)", () => {
  it("seeds from the real state but never writes: simulated add/remove/save leave the file byte-identical", () => {
    addPosition("mainnet", pos("BTC"));
    const before = readFileSync(main, "utf-8");
    const st = createDaemonStateStore("mainnet", true, CONFIG);
    expect(st.load()!.positions.map(p => p.symbol)).toEqual(["BTC"]);
    st.add(pos("SOL"));
    st.remove("BTC"); // a simulated close of a REAL position
    const s = st.load()!;
    s.lastScanTime = "x";
    st.save(s);
    expect(st.load()!.positions.map(p => p.symbol)).toEqual(["SOL"]);
    expect(readFileSync(main, "utf-8")).toBe(before);
    expect(getPositions("mainnet").map(p => p.symbol)).toEqual(["BTC"]);
  });

  it("dry-run over a legacy untagged file neither tags it nor writes a backup", () => {
    const legacy = { ...createInitialState(CONFIG), positions: [pos("PURR")] };
    delete (legacy as { network?: string }).network;
    const raw = JSON.stringify(legacy, null, 2);
    writeFileSync(main, raw);
    const store = createDaemonStateStore("mainnet", true, CONFIG);
    expect(store.load()?.positions.map(p => p.symbol)).toEqual(["PURR"]);
    store.remove("PURR");
    expect(readFileSync(main, "utf-8")).toBe(raw);
    expect(existsSync(`${main}.pre-network.bak`)).toBe(false);
  });

  it("a corrupt mainnet file makes the testnet guard throw a structured error", () => {
    writeFileSync(main, "{not json");
    expect(() => loadArbState("testnet")).toThrow(/is not valid JSON .* refusing to guess its network/);
  });

  it("dry-run with no state file creates nothing on disk", () => {
    const st = createDaemonStateStore("testnet", true, CONFIG);
    st.save(createInitialState(CONFIG));
    st.add(pos("ETH"));
    expect(st.load()!.positions.map(p => p.symbol)).toEqual(["ETH"]);
    expect(existsSync(arbStateFilePath("testnet"))).toBe(false);
    expect(existsSync(main)).toBe(false);
  });

  it("live store writes the per-network file", () => {
    const st = createDaemonStateStore("testnet", false, CONFIG);
    st.add(pos("ETH"));
    expect(getPositions("testnet").map(p => p.symbol)).toEqual(["ETH"]);
    expect(existsSync(main)).toBe(false);
  });
});
