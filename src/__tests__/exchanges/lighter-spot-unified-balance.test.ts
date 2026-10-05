/**
 * Lighter / Lighter RH `trade spot-balance` on a Unified Trading Account.
 * Live shape: GET https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=723334
 * (2026-10-05, trimmed) — the quote sits in assets[].margin_balance with balance "0.000000",
 * so the balance-only read returned [] and the E2E runner saw "spot USDC available unreadable".
 */
import { describe, it, expect, vi } from "vitest";
import type { LighterAdapter } from "../../exchanges/lighter.js";
import { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";

const LIVE_UNIFIED = {
  code: 0, account_type: 0, index: 723334, account_index: 723334, l1_address: "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3",
  available_balance: "15.952247", collateral: "15.952247", total_asset_value: "15.952247", account_trading_mode: 1,
  assets: [{ symbol: "USDC", asset_id: 3, balance: "0.000000", locked_balance: "0.000000", margin_mode: "enabled", margin_balance: "15.952247503314", multiplier: "1.000000000000000000" }],
};

function build(acct: Record<string, unknown>, venue: "lighter" | "lighter-rh" = "lighter", quote = "USDC") {
  const lt = { name: venue, address: "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3", accountIndex: 723334, accountCachePrefix: `test-${venue}-${Math.random()}`, collateralSymbol: quote } as unknown as LighterAdapter;
  const spot = new LighterSpotAdapter(lt) as LighterSpotAdapter & Record<string, unknown>;
  spot._initialized = true;
  const restGet = vi.fn(async (path: string) => {
    if (path === "/account") return { accounts: [acct] };
    throw new Error(`unexpected GET ${path}`);
  });
  spot._restGet = restGet;
  return { spot, restGet };
}

describe("Lighter spot balances — unified trading account", () => {
  it("live account 723334: quote row with shared true, available = account available_balance", async () => {
    const { spot, restGet } = build(LIVE_UNIFIED);
    await expect(spot.getSpotBalancesFresh()).resolves.toEqual([
      { token: "USDC", total: "15.952247503314", available: "15.952247", held: "0.000000", shared: true },
    ]);
    expect(restGet).toHaveBeenCalledTimes(1);
  });

  it("row shape the E2E runner reads: token === quote (case-insensitive), numeric available, shared", async () => {
    const { spot } = build(LIVE_UNIFIED);
    const rows = await spot.getSpotBalancesFresh();
    const q = rows.find(r => r.token.toUpperCase() === "USDC");
    expect(Number(q?.available)).toBe(15.952247);
    expect(q?.shared).toBe(true);
  });

  it("Lighter RH quotes USDG; perp margin in use lowers available, held base assets are listed", async () => {
    const { spot } = build({
      ...LIVE_UNIFIED, available_balance: "9.100000",
      assets: [
        { symbol: "USDG", asset_id: 3, balance: "0.000000", locked_balance: "0.000000", margin_mode: "enabled", margin_balance: "13.000000" },
        { symbol: "ETH", asset_id: 1, balance: "0.01000000", locked_balance: "0.00400000", margin_mode: "disabled", margin_balance: "0.00000000" },
      ],
    }, "lighter-rh", "USDG");
    await expect(spot.getSpotBalancesFresh()).resolves.toEqual([
      { token: "USDG", total: "13", available: "9.100000", held: "0.000000", shared: true },
      { token: "ETH", total: "0.01000000", available: "0.006", held: "0.00400000", shared: false },
    ]);
  });

  it("unified with no quote at all → no quote row", async () => {
    const { spot } = build({ ...LIVE_UNIFIED, available_balance: "0.000000", assets: [{ ...LIVE_UNIFIED.assets[0], margin_balance: "0.000000" }] });
    await expect(spot.getSpotBalancesFresh()).resolves.toEqual([]);
  });

  it("classic: the separate spot quote balance is named by the bare quote (USDC, shared false) — never USDC_SPOT", async () => {
    const { spot } = build({ ...LIVE_UNIFIED, account_trading_mode: 0, assets: [{ ...LIVE_UNIFIED.assets[0], balance: "5.000000", locked_balance: "1.000000", margin_balance: "0.000000" }] });
    await expect(spot.getSpotBalancesFresh()).resolves.toEqual([
      { token: "USDC", total: "5.000000", available: "4", held: "1.000000", shared: false },
    ]);
  });

  it("unreadable margin_balance / available_balance / mode → EXCHANGE_ERROR, never an empty list", async () => {
    await expect(build({ ...LIVE_UNIFIED, assets: [{ ...LIVE_UNIFIED.assets[0], margin_balance: undefined }] }).spot.getSpotBalancesFresh())
      .rejects.toThrow(/USDC margin_balance is null/);
    await expect(build({ ...LIVE_UNIFIED, available_balance: "" }).spot.getSpotBalancesFresh())
      .rejects.toThrow(/available_balance is ""/);
    await expect(build({ ...LIVE_UNIFIED, account_trading_mode: 2 }).spot.getSpotBalancesFresh())
      .rejects.toThrow(/account_trading_mode is 2/);
  });
});
