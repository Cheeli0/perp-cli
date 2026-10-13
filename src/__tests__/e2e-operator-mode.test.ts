/**
 * E2E runner — operator-authorized mainnet mode, minimum-capital spot funding and deposit /
 * withdraw limits (2026-10-05). Pure runner helpers only: nothing here talks to a venue.
 */
import { describe, it, expect } from "vitest";
import {
  mainnetStartGate, projectedExposureUsd, spotHoldingOf, spotQuoteNeed, planSpotFunding, fundingAmountProblem, lighterAssetMinimums, unitsFromHex, depositWalletProblem, renderMarkdown,
  type RunReport,
} from "../../scripts/e2e/lib.js";
import { PROFILES } from "../../scripts/e2e/venues.js";
import { MAINNET_USDC_MINT } from "../pacifica/constants.js";
import { LIGHTER_RH_NETWORKS } from "../exchanges/venues/lighter-family.js";

const gate = (o: Partial<Parameters<typeof mainnetStartGate>[0]>) =>
  mainnetStartGate({ venue: "hyperliquid", confirmRealMoney: true, operatorAuthorized: null, maxUsd: 20, defaultCapUsd: 20, interactive: false, ...o });

describe("mainnetStartGate (--operator-authorized)", () => {
  it("match: starts without a TTY, replacing only the typed venue name", () => {
    expect(gate({ operatorAuthorized: "hyperliquid" })).toEqual({ kind: "start", raiseCap: false, typeVenue: false, operatorAuthorized: true });
  });

  it("mismatch: refused, with or without a TTY", () => {
    for (const interactive of [false, true]) {
      const g = gate({ operatorAuthorized: "pacifica", interactive });
      expect(g.kind).toBe("refuse");
      expect(g.kind === "refuse" && g.message).toMatch(/does not match --venue hyperliquid/);
    }
    // No prefix / case-insensitive match.
    expect(gate({ operatorAuthorized: "Hyperliquid" }).kind).toBe("refuse");
    expect(gate({ venue: "lighter-rh", operatorAuthorized: "lighter" }).kind).toBe("refuse");
  });

  it("missing --confirm-real-money: refused even with a matching operator flag", () => {
    const g = gate({ confirmRealMoney: false, operatorAuthorized: "hyperliquid" });
    expect(g).toEqual({ kind: "refuse", message: "Mainnet run without --dry-run requires --confirm-real-money." });
  });

  it("cap raise stays TTY-only: a non-interactive operator run cannot go above the default cap", () => {
    const g = gate({ operatorAuthorized: "hyperliquid", maxUsd: 21 });
    expect(g.kind).toBe("refuse");
    expect(g.kind === "refuse" && g.message).toMatch(/cannot raise the cap/);
    // With a TTY the RAISE-CAP-<N> typing is still required.
    expect(gate({ operatorAuthorized: "hyperliquid", maxUsd: 21, interactive: true })).toEqual({ kind: "start", raiseCap: true, typeVenue: false, operatorAuthorized: true });
    // At or below the cap nothing is raised.
    expect(gate({ operatorAuthorized: "hyperliquid", maxUsd: 15 })).toMatchObject({ kind: "start", raiseCap: false });
  });

  it("no operator flag: unchanged — TTY + typed venue name, refused on a non-TTY", () => {
    expect(gate({}).kind).toBe("refuse");
    expect(gate({ interactive: true })).toEqual({ kind: "start", raiseCap: false, typeVenue: true, operatorAuthorized: false });
    expect(gate({ interactive: true, maxUsd: 50 })).toEqual({ kind: "start", raiseCap: true, typeVenue: true, operatorAuthorized: false });
  });

  it("report markdown carries the operator-authorized marker", () => {
    const report: RunReport = {
      tool: "perp-e2e", version: 1, startedAt: "2026-10-05T00:00:00.000Z", finishedAt: null, venue: "hyperliquid", cliVenue: "hyperliquid", dex: null,
      network: "mainnet", phases: ["preflight"], dryRun: false, operatorAuthorized: true, cliVersion: null, gitCommit: null, options: {}, market: null, sizing: null,
      hip3: null, capabilities: null, prerequisites: [], steps: [], designItems: {}, stopReason: null, cleanup: [], result: "pass",
    };
    expect(renderMarkdown(report)).toMatch(/OPERATOR-AUTHORIZED mainnet run/);
    expect(renderMarkdown({ ...report, operatorAuthorized: false })).not.toMatch(/OPERATOR-AUTHORIZED/);
  });
});

describe("spot funding need (buy → sell → resting limit)", () => {
  it("need = 1.05 × notional (the far limit reuses the sell proceeds)", () => {
    expect(spotQuoteNeed(11)).toBeCloseTo(11.55, 10);
    expect(spotQuoteNeed(13.5).toFixed(2)).toBe("14.18");
    expect(() => spotQuoteNeed(0)).toThrow(/positive/);
    expect(() => spotQuoteNeed(NaN)).toThrow(/positive/);
  });

  it("planSpotFunding with the 1.05× need: 12 withdrawable funds an $11 buy (2.05× would have skipped)", () => {
    const need = Number(spotQuoteNeed(11).toFixed(2));
    expect(planSpotFunding({ asset: "USDC", need, spotAvail: 0, perpWithdrawable: 12, shared: false })).toMatchObject({ kind: "fund", transfer: "11.55" });
    expect(planSpotFunding({ asset: "USDC", need: 11 * 2.05, spotAvail: 0, perpWithdrawable: 12, shared: false }).kind).toBe("skip");
  });

  it("planSpotFunding exercise = the live minimum transfer", () => {
    expect(planSpotFunding({ asset: "USDC", need: 5, spotAvail: 10, perpWithdrawable: 40, shared: false, exercise: 2 })).toMatchObject({ kind: "fund", transfer: "2.00" });
  });
});

describe("deposit / withdraw limits", () => {
  const limits = (route: (typeof PROFILES)["hyperliquid"]["deposit"]["mainnet"], phase: "deposit" | "withdraw", amount: number, liveMin: number | null = null) => {
    if (route.kind !== "cli") throw new Error("not a CLI route");
    return fundingAmountProblem({ phase, amount, min: liveMin !== null ? Math.max(route.min ?? 0, liveMin) : route.min, minSource: route.minSource, belowMinLost: route.belowMinLost, maxUsd: 20 });
  };

  it("Hyperliquid deposit below 5 USDC is refused (funds would be lost)", () => {
    const route = PROFILES.hyperliquid.deposit.mainnet;
    expect(limits(route, "deposit", 4.99)).toMatch(/below the minimum 5 .*funds are lost/);
    expect(limits(route, "deposit", 5)).toBeNull();
    expect(limits(route, "deposit", 12)).toBeNull();
    expect(limits(route, "deposit", 21)).toMatch(/> --max-usd 20/);
    expect(limits(route, "deposit", NaN)).toMatch(/positive number/);
  });

  it("Hyperliquid withdraw: 1 USDC fee, minimum above it", () => {
    const route = PROFILES.hyperliquid.withdraw.mainnet;
    expect(route.kind === "cli" && route.fee).toMatchObject({ amount: 1, asset: "USDC" });
    expect(limits(route, "withdraw", 1)).toMatch(/below the minimum 2/);
    expect(limits(route, "withdraw", 2)).toBeNull();
  });

  it("Pacifica mainnet withdraw uses the conservative 10 USDC (1 was refused on testnet)", () => {
    const route = PROFILES.pacifica.withdraw.mainnet;
    expect(route.kind === "cli" && route.min).toBe(10);
    expect(limits(route, "withdraw", 5)).toMatch(/below the minimum 10/);
    expect(limits(route, "withdraw", 10)).toBeNull();
  });

  it("Lighter family withdraw enforces the live assetDetails minimum", () => {
    const body = { code: 200, asset_details: [{ asset_id: 3, symbol: "USDG", min_transfer_amount: "1.000000", min_withdrawal_amount: "3.000000" }] };
    const mins = lighterAssetMinimums(body, 3);
    expect(mins).toEqual({ symbol: "USDG", minTransfer: 1, minWithdrawal: 3 });
    for (const venue of ["lighter", "lighter-rh"] as const) {
      const route = PROFILES[venue].withdraw.mainnet;
      expect(route.kind === "cli" && route.liveMin).toBe("lighterAssetDetails");
      expect(limits(route, "withdraw", 2, mins.minWithdrawal)).toMatch(/below the minimum 3/);
      expect(limits(route, "withdraw", 3, mins.minWithdrawal)).toBeNull();
    }
    expect(() => lighterAssetMinimums({ asset_details: [{ asset_id: 3, symbol: "USDC", min_transfer_amount: "1.0" }] }, 3)).toThrow(/min_withdrawal_amount/);
    expect(() => lighterAssetMinimums({ asset_details: [] }, 3)).toThrow(/not listed/);
    expect(() => lighterAssetMinimums({}, 3)).toThrow(/asset_details/);
  });

  it("every CLI route declares where its minimum comes from; deposit routes on mainnet name their wallet", () => {
    for (const p of Object.values(PROFILES)) {
      for (const net of ["mainnet", "testnet"] as const) {
        for (const [phase, route] of [["deposit", p.deposit[net]], ["withdraw", p.withdraw[net]]] as const) {
          if (route.kind !== "cli") continue;
          expect(route.minSource.length, `${p.id} ${phase} ${net}`).toBeGreaterThan(0);
          expect(route.wallet !== null, `${p.id} ${phase} ${net} wallet`).toBe(phase === "deposit");
        }
      }
    }
  });

  it("deposit wallet constants match the CLI's own", () => {
    const pac = PROFILES.pacifica.deposit.mainnet;
    expect(pac.kind === "cli" && pac.wallet?.token).toBe(MAINNET_USDC_MINT);
    // Lighter RH reads rpcUrl / token from the venue definition — both must be declared there.
    const rh = PROFILES["lighter-rh"].deposit.mainnet;
    expect(rh.kind === "cli" && rh.wallet).toMatchObject({ rpcUrl: null, token: null, asset: LIGHTER_RH_NETWORKS.mainnet.collateral[0] });
    expect(LIGHTER_RH_NETWORKS.mainnet.rpcUrl).not.toBeNull();
    expect(LIGHTER_RH_NETWORKS.mainnet.depositPins?.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("exposure accounting", () => {
  it("an edit counts as the replacement delta; a new order adds to what is open", () => {
    // $10.53 resting, edited to $11.02: the old order is replaced, not added to.
    expect(projectedExposureUsd(10.53, 11.02, 10.53)).toBeCloseTo(11.02, 10);
    expect(projectedExposureUsd(10.53, 11.02, 0)).toBeCloseTo(21.55, 10);
    // Resting sell against the long it would close.
    expect(projectedExposureUsd(11.07, 11.07, 11.07)).toBeCloseTo(11.07, 10);
    // The offset never goes below zero open exposure.
    expect(projectedExposureUsd(5, 11, 8)).toBe(11);
    expect(() => projectedExposureUsd(NaN, 1, 0)).toThrow(/open/);
  });

  it("spotHoldingOf matches the token exactly (ETH is not ETHFI)", () => {
    const data = { balances: [{ token: "ETHFI", total: "7" }, { token: "ETH", total: "0.5" }] };
    expect(spotHoldingOf(data, "ETH")).toBe(0.5);
    expect(spotHoldingOf({ balances: [{ token: "ETHFI", total: "7" }] }, "eth")).toBe(0);
  });
});

describe("deposit wallet preflight", () => {
  it("the Pacifica deposit is direct only (--no-relay)", () => {
    const route = PROFILES.pacifica.deposit.mainnet;
    expect(route.kind === "cli" && route.args("12")).toEqual(["funds", "deposit", "pacifica", "12", "--no-relay"]);
  });

  it("unitsFromHex reads JSON-RPC quantities and refuses anything else", () => {
    expect(unitsFromHex("0xb71b00", 6)).toBe(12);
    expect(unitsFromHex("0x38d7ea4c68000", 18)).toBeCloseTo(0.001, 12);
    expect(unitsFromHex("0x0", 6)).toBe(0);
    expect(() => unitsFromHex("0x", 6)).toThrow(/hex quantity/);
    expect(() => unitsFromHex("12", 6)).toThrow(/hex quantity/);
  });

  it("refuses a deposit above the wallet balance or with 0 gas", () => {
    const w = { asset: "USDC", gasAsset: "ETH", minGas: 0.0001 };
    expect(depositWalletProblem({ ...w, amount: 12, tokenBalance: 11.99, gasBalance: 0.001 })).toMatch(/--deposit-amount 12 > wallet balance 11.99 USDC/);
    expect(depositWalletProblem({ ...w, amount: 12, tokenBalance: 12, gasBalance: 0.001 })).toBeNull();
    expect(depositWalletProblem({ ...w, amount: 5, tokenBalance: 100, gasBalance: 0 })).toMatch(/0 ETH for gas/);
    // Under the CLI deposit's own gas check (Pacifica direct deposit: 0.005 SOL).
    expect(depositWalletProblem({ asset: "USDC", gasAsset: "SOL", minGas: 0.005, amount: 12, tokenBalance: 20, gasBalance: 0.00092 })).toMatch(/needs at least 0.005/);
    expect(depositWalletProblem({ ...w, amount: null, tokenBalance: 0, gasBalance: 0.001 })).toBeNull();
    expect(depositWalletProblem({ ...w, amount: 5, tokenBalance: NaN, gasBalance: 1 })).toMatch(/not a number/);
  });
});
