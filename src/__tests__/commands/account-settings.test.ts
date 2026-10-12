/**
 * `account settings`: the per-market leverage / margin mode each venue itself exposes
 * (adapter.getMarketSettings), or the uniform CAPABILITY_UNSUPPORTED — never an empty list.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import "../../exchanges/venues/index.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
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
  it("Hyperliquid: leverage.type / leverage.value of every clearinghouseState position", async () => {
    const hl = new HyperliquidAdapter(undefined, false);
    const h = hl as unknown as Record<string, unknown>;
    h._assetMap = new Map([["ETH-PERP", 1]]);
    h._getClearinghouseState = async () => ({ assetPositions: [
      { position: { coin: "ETH", szi: "0.01", leverage: { type: "isolated", value: 5, rawUsd: "-20.1" } } },
      { position: { coin: "xyz:TSLA", szi: "-1", leverage: { type: "cross", value: 3 } } },
    ] });
    expect(await settings(hl)).toEqual([
      { symbol: "ETH-PERP", leverage: 5, margin_mode: "isolated" },
      { symbol: "xyz:TSLA", leverage: 3, margin_mode: "cross" },
    ]);
    h._getClearinghouseState = async () => ({ assetPositions: [{ position: { coin: "ETH", szi: "1" } }] });
    await expect(settings(hl)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("Hyperliquid without a position: CAPABILITY_UNSUPPORTED (the one-read source lists positions only), never []", async () => {
    const hl = new HyperliquidAdapter(undefined, false);
    (hl as unknown as Record<string, unknown>)._getClearinghouseState = async () => ({ assetPositions: [] });
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
