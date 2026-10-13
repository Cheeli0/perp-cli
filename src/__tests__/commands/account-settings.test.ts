/**
 * `account settings`: the per-market leverage / margin mode each venue itself exposes
 * (adapter.getMarketSettings), or the uniform CAPABILITY_UNSUPPORTED — never an empty list.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import "../../exchanges/venues/index.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HL_SETTINGS_FILL_MARKETS, HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { AsterAdapter } from "../../exchanges/aster.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

afterEach(() => vi.restoreAllMocks());

async function settings(adapter: unknown): Promise<unknown> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  addRootSafetyOptions(program);
  program.exitOverride();
  registerAccountCommands(program, async () => adapter as ExchangeAdapter, () => true);
  await program.parseAsync(["node", "perp", "account", "settings"]);
  return (JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { data: unknown }).data;
}

describe("account settings", () => {
  /** HL adapter with a user address, a core asset map, and a recording info stub. */
  function hlWith(positions: unknown[], fills: unknown, assetData: Record<string, unknown> = {}) {
    const hl = new HyperliquidAdapter(undefined, false);
    const h = hl as unknown as Record<string, unknown>;
    h._address = "0x00000000000000000000000000000000000000bb";
    h._assetMap = new Map([["ETH-PERP", 1], ["BTC-PERP", 0], ["SOL-PERP", 5]]);
    h._getClearinghouseState = async () => ({ assetPositions: positions });
    const info = vi.fn(async (body: Record<string, unknown>) => {
      if (body.type === "userFills") return fills;
      if (body.type === "activeAssetData") return assetData[String(body.coin)] ?? null;
      throw new Error(`unexpected ${JSON.stringify(body)}`);
    });
    h._infoPost = info;
    return { hl, info };
  }

  it("Hyperliquid: leverage.type / leverage.value of every clearinghouseState position", async () => {
    const { hl } = hlWith([
      { position: { coin: "ETH", szi: "0.01", leverage: { type: "isolated", value: 5, rawUsd: "-20.1" } } },
      { position: { coin: "xyz:TSLA", szi: "-1", leverage: { type: "cross", value: 3 } } },
    ], []);
    expect(await settings(hl)).toEqual([
      { symbol: "ETH-PERP", leverage: 5, margin_mode: "isolated" },
      { symbol: "xyz:TSLA", leverage: 3, margin_mode: "cross" },
    ]);
    const { hl: bad } = hlWith([{ position: { coin: "ETH", szi: "1" } }], []);
    await expect(settings(bad)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("Hyperliquid without a position: activeAssetData {user, coin} of recently traded perp markets (newest first; spot / outcome / other-dex / delisted / held coins skipped)", async () => {
    const fills = [
      { coin: "BTC", time: 1 }, { coin: "@107", time: 9 }, { coin: "#14881", time: 8 }, { coin: "xyz:TSLA", time: 7 },
      { coin: "DELISTED", time: 6 }, { coin: "SOL", time: 5 }, { coin: "ETH", time: 4 }, { coin: "SOL", time: 3 },
    ];
    const { hl, info } = hlWith([{ position: { coin: "ETH", szi: "1", leverage: { type: "cross", value: 10 } } }], fills, {
      SOL: { user: "0x…", coin: "SOL", leverage: { type: "isolated", value: 3 }, markPx: "150" },
      BTC: { user: "0x…", coin: "BTC", leverage: { type: "cross", value: 20 }, markPx: "60000" },
    });
    expect(await settings(hl)).toEqual([
      { symbol: "ETH-PERP", leverage: 10, margin_mode: "cross" },
      { symbol: "SOL-PERP", leverage: 3, margin_mode: "isolated" },
      { symbol: "BTC-PERP", leverage: 20, margin_mode: "cross" },
    ]);
    expect(info.mock.calls.map(c => c[0])).toEqual([
      { type: "userFills", user: "0x00000000000000000000000000000000000000bb" },
      { type: "activeAssetData", user: "0x00000000000000000000000000000000000000bb", coin: "SOL" },
      { type: "activeAssetData", user: "0x00000000000000000000000000000000000000bb", coin: "BTC" },
    ]);
  });

  it("Hyperliquid: activeAssetData reads are capped at HL_SETTINGS_FILL_MARKETS (weight 20 each)", async () => {
    const coins = Array.from({ length: HL_SETTINGS_FILL_MARKETS + 3 }, (_, i) => `C${i}`);
    const { hl, info } = hlWith([], coins.map((coin, i) => ({ coin, time: 100 - i })),
      Object.fromEntries(coins.map(c => [c, { leverage: { type: "cross", value: 2 } }])));
    (hl as unknown as { _assetMap: Map<string, number> })._assetMap = new Map(coins.map((c, i) => [`${c}-PERP`, i]));
    const rows = await settings(hl) as Array<{ symbol: string }>;
    expect(rows.map(r => r.symbol)).toEqual(coins.slice(0, HL_SETTINGS_FILL_MARKETS).map(c => `${c}-PERP`));
    expect(info.mock.calls.filter(c => c[0].type === "activeAssetData")).toHaveLength(HL_SETTINGS_FILL_MARKETS);
  });

  it("Hyperliquid: an unreadable activeAssetData leverage is EXCHANGE_ERROR; userFills that is not a list is EXCHANGE_ERROR", async () => {
    const { hl } = hlWith([], [{ coin: "SOL", time: 1 }], { SOL: { leverage: { type: "cross" } } });
    await expect(settings(hl)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    const { hl: noList } = hlWith([], { error: "x" });
    await expect(settings(noList)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("Hyperliquid with no position and no traded perp market: CAPABILITY_UNSUPPORTED, never []", async () => {
    const { hl } = hlWith([], [{ coin: "@107", time: 1 }]);
    await expect(settings(hl)).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { venue: "hyperliquid", feature: "accountSettings" } } });
  });

  it("Aster: leverage + marginType of every positionRisk row (flat markets included)", async () => {
    const a = new AsterAdapter(undefined, false);
    const h = a as unknown as Record<string, unknown>;
    h._resolveSigner = () => ({ tier: "agent" });
    const get = vi.fn(async (_path: string) => [
      { symbol: "SOLUSDT", marginType: "isolated", leverage: "3", positionAmt: "0.000", positionSide: "BOTH" },
      { symbol: "BTCUSDT", marginType: "cross", leverage: "10", positionAmt: "0.002", positionSide: "BOTH" },
    ]);
    h._signedGetEip712 = get;
    expect(await settings(a)).toEqual([
      { symbol: "SOL", leverage: 3, margin_mode: "isolated" },
      { symbol: "BTC", leverage: 10, margin_mode: "cross" },
    ]);
    expect(get.mock.calls[0][0]).toBe("/fapi/v3/positionRisk");
    h._signedGetEip712 = async () => [{ symbol: "SOLUSDT", leverage: "3" }];
    await expect(settings(a)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("a venue without a settings read: uniform CAPABILITY_UNSUPPORTED (not positions with a hard-coded 'cross')", async () => {
    const getPositions = vi.fn();
    await expect(settings({ name: "qfex", getPositions })).rejects.toMatchObject({
      structured: { code: "CAPABILITY_UNSUPPORTED", details: { venue: "qfex", feature: "accountSettings" } },
    });
    expect(getPositions).not.toHaveBeenCalled();
  });
});
