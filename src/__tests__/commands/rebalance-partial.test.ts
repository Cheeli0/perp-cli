/**
 * funds rebalance (audit M5): a venue whose adapter or balance read failed is reported —
 * check / plan mark the result partial; execute aborts before any withdrawal.
 * Adapters are mocks; nothing is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerFundsRebalanceCommands } from "../../commands/rebalance.js";
import type { ExchangeAdapter, ExchangeBalance } from "../../exchanges/interface.js";

const BAL = (available: string): ExchangeBalance => ({ equity: available, available, marginUsed: "0", unrealizedPnl: "0" });

let withdraw: ReturnType<typeof vi.fn>;

function adapterFor(name: string): ExchangeAdapter {
  if (name === "aster") throw new Error("no credentials");
  return {
    name,
    getBalance: name === "lighter" ? async () => { throw new Error("HTTP 503"); } : async () => BAL(name === "hyperliquid" ? "1000" : "100"),
    withdraw,
  } as unknown as ExchangeAdapter;
}

function program(): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p);
  p.option("--json");
  const funds = p.command("funds");
  registerFundsRebalanceCommands(funds, async (ex) => adapterFor(ex), () => p.opts().json ?? false, () => "mainnet");
  return p;
}

async function runJson(args: string[]) {
  let out = "";
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out += a.map(String).join(" ") + "\n"; });
  try {
    await program().parseAsync(["node", "perp", "--json", ...args]);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out.trim());
}

beforeEach(() => { withdraw = vi.fn(); });

describe("funds rebalance — partial reads", () => {
  it("check: adapter + balance failures listed in unavailable, partial true", async () => {
    const res = await runJson(["funds", "rebalance", "check", "--exchanges", "hyperliquid,pacifica,lighter,aster"]);
    expect(res.data.partial).toBe(true);
    expect(res.data.unavailable).toEqual([
      { exchange: "aster", error: "no credentials" },
      { exchange: "lighter", error: "HTTP 503" },
    ]);
    expect(res.data.snapshots.map((s: { exchange: string }) => s.exchange).sort()).toEqual(["hyperliquid", "pacifica"]);
  });

  it("plan: partial true and the failed venue listed", async () => {
    const res = await runJson(["funds", "rebalance", "plan", "--exchanges", "hyperliquid,pacifica,lighter"]);
    expect(res.data.partial).toBe(true);
    expect(res.data.unavailable).toEqual([{ exchange: "lighter", error: "HTTP 503" }]);
  });

  it("plan: all venues read → partial false", async () => {
    const res = await runJson(["funds", "rebalance", "plan", "--exchanges", "hyperliquid,pacifica"]);
    expect(res.data).toMatchObject({ partial: false, unavailable: [] });
  });

  it("execute: aborts with a PerpError before any withdrawal when a requested venue was not read", async () => {
    await expect(program().parseAsync(["node", "perp", "--json", "funds", "rebalance", "execute", "--exchanges", "hyperliquid,pacifica,lighter"]))
      .rejects.toMatchObject({
        name: "PerpError",
        structured: { code: "EXCHANGE_ERROR", details: { unavailable: [{ exchange: "lighter", error: "HTTP 503" }] } },
      });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("execute: an adapter-init failure also aborts (no silent skip)", async () => {
    await expect(program().parseAsync(["node", "perp", "--json", "funds", "rebalance", "execute", "--exchanges", "hyperliquid,pacifica,aster"]))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", remediation: expect.stringContaining("--exchanges hyperliquid,pacifica") } });
    expect(withdraw).not.toHaveBeenCalled();
  });
});
