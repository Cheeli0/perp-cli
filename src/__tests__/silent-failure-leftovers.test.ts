/**
 * Leftovers of the silent-failure audit: bridge quotes, funding-arb drawdown on a partial
 * balance read, arb rebalance on a partial read. A failure is surfaced, never treated as
 * "no route" / a smaller drawdown / a plan over fewer venues.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("getAllQuotes", () => {
  it("every provider failing → NO_BRIDGE_ROUTE naming each provider's reason (not an empty list)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { getAllQuotes } = await import("../bridge-engine.js");
    const addr = "0x1111111111111111111111111111111111111111";
    const err = await getAllQuotes("arbitrum", "base", 10, addr, addr).catch(e => e);
    expect(err).toMatchObject({ structured: expect.objectContaining({ code: "NO_BRIDGE_ROUTE" }) });
    expect(err.message).toMatch(/cctp: .*relay: .*debridge: /);
  });
});

describe("rebalance balance reads", () => {
  it("fetchBalancesWithFailures returns the failed venue instead of dropping it", async () => {
    const { fetchBalancesWithFailures } = await import("../rebalance.js");
    const ok = { getBalance: vi.fn(async () => ({ equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "-5" })) };
    const bad = { getBalance: vi.fn(async () => { throw new Error("HTTP 502"); }) };
    const r = await fetchBalancesWithFailures(new Map([["hyperliquid", ok], ["lighter", bad]]) as never);
    expect(r.snapshots.map(s => s.exchange)).toEqual(["hyperliquid"]);
    expect(r.failed).toEqual([{ exchange: "lighter", error: expect.stringContaining("HTTP 502") }]);
  });
});

describe("venues without credentials are 'not configured', not failed reads", () => {
  it("fetchBalancesWithFailures does not read a read-only adapter and lists it in notConfigured", async () => {
    const { fetchBalancesWithFailures } = await import("../rebalance.js");
    const ok = { getBalance: vi.fn(async () => ({ equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "0" })) };
    const ro = { isReadOnly: true, getBalance: vi.fn(async () => { throw new Error("No private key configured"); }) };
    const r = await fetchBalancesWithFailures(new Map([["hyperliquid", ok], ["aster", ro]]) as never);
    expect(r.failed).toEqual([]);
    expect(r.notConfigured).toEqual(["aster"]);
    expect(ro.getBalance).not.toHaveBeenCalled();
  });

  it("loadBotVenueAdapters: a read-only venue is skipped from a default list and refused from an explicit one", async () => {
    const { loadBotVenueAdapters } = await import("../commands/bot.js");
    const get = async (n: string) => ({ name: n, isReadOnly: n === "aster" }) as never;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const loaded = await loadBotVenueAdapters(["hyperliquid", "aster"], false, get);
    expect([...loaded.keys()]).toEqual(["hyperliquid"]);
    expect(stderr.mock.calls.some(c => String(c[0]).includes("aster not configured"))).toBe(true);
    await expect(loadBotVenueAdapters(["hyperliquid", "aster"], true, get)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "NO_SIGNER_AVAILABLE" }) });
  });
});
