/**
 * Pre-release QA sweep (0.15.0) — `perp health` probed only pacifica / hyperliquid / lighter /
 * aster. It now runs the same probe as `perp portfolio --health` and the MCP health_check
 * (src/venue-health.ts): every registered venue, read-only venues through their public
 * market-data read, unofficial APIs tagged, venues without an environment on the network listed
 * under `skipped` (never silently dropped).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../cli-flags.js";
import { registerRiskCommands } from "../commands/risk.js";
import { probeVenueHealth } from "../venue-health.js";
import { listVenues } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });

function offline() {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  for (const v of listVenues()) vi.spyOn(v.publicData, "fetchMarkets").mockRejectedValue(new Error(`${v.id} offline`));
}

describe("probeVenueHealth", () => {
  it("mainnet: one probe per registered venue, each failure with its message", async () => {
    offline();
    const h = await probeVenueHealth("mainnet");
    expect(h.probes.map((p) => p.venue)).toEqual(listVenues().map((v) => v.id));
    expect(h.skipped).toEqual([]);
    expect(h.allHealthy).toBe(false);
    for (const p of h.probes) expect(p.error).toEqual(expect.any(String));
  });

  it("read-only TxFlow is probed through its market-data read and tagged unofficial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const txflow = listVenues().find((v) => v.id === "txflow")!;
    const fetchMarkets = vi.spyOn(txflow.publicData, "fetchMarkets").mockResolvedValue([]);
    const h = await probeVenueHealth("mainnet", ["txflow", "aster"]);
    expect(fetchMarkets).toHaveBeenCalledWith("mainnet");
    expect(h.probes).toEqual([
      expect.objectContaining({ venue: "txflow", ok: true, probe: "markets", status: null, error: null, apiStatus: "unofficial" }),
      expect.objectContaining({ venue: "aster", ok: true, probe: "ping", status: 200, apiStatus: "official" }),
    ]);
  });

  it("testnet: a venue without a testnet environment is listed under skipped with the reason", async () => {
    offline();
    const h = await probeVenueHealth("testnet");
    const noTestnet = listVenues().filter((v) => v.networks.testnet === null).map((v) => v.id);
    expect(noTestnet).toContain("txflow");
    expect(h.skipped.map((s) => s.venue)).toEqual(noTestnet);
    expect(h.skipped[0].reason).toMatch(/no testnet environment/);
    expect(h.probes.map((p) => p.venue)).toEqual(listVenues().filter((v) => v.networks.testnet !== null).map((v) => v.id));
  });
});

describe("perp health", () => {
  async function health(argv: string[]) {
    const program = new Command();
    program.exitOverride();
    addRootSafetyOptions(program).option("--json");
    registerRiskCommands(program, async () => { throw new Error("no adapter needed"); }, () => program.opts().json === true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", ...argv]);
    return out;
  }

  it("--json covers every registered venue (not the former 4) with apiStatus and probe kind", async () => {
    offline();
    const out = await health(["--json", "health"]);
    const env = JSON.parse(out[0]);
    expect(env.ok).toBe(true);
    expect(env.data.network).toBe("mainnet");
    expect(env.data.healthy).toBe(false);
    expect(env.data.exchanges.map((e: { exchange: string }) => e.exchange)).toEqual(listVenues().map((v) => v.id));
    expect(env.data.exchanges.find((e: { exchange: string }) => e.exchange === "txflow")).toMatchObject({ status: "down", probe: "markets", apiStatus: "unofficial" });
    expect(env.data.skipped).toEqual([]);
  });

  it("-n testnet reports TxFlow as skipped", async () => {
    offline();
    const env = JSON.parse((await health(["-n", "testnet", "--json", "health"]))[0]);
    expect(env.data.network).toBe("testnet");
    expect(env.data.skipped.map((s: { venue: string }) => s.venue)).toContain("txflow");
  });
});
