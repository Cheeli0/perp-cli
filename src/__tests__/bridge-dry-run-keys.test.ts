/**
 * Review L3: `funds bridge send --dry-run --sender <a> --recipient <b>` plans from public data
 * only — no private key is loaded (no decrypt, no passphrase prompt). Quotes are mocked; nothing
 * is sent anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { Wallet } from "ethers";

const loadPrivateKey = vi.fn(async (): Promise<string> => { throw new Error("key must not be loaded in this dry-run"); });
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  loadPrivateKey: (...a: unknown[]) => loadPrivateKey(...(a as [])),
}));
const getAllQuotes = vi.fn(async () => [{
  provider: "cctp", srcChain: "arbitrum", dstChain: "base", amountIn: 10, amountOut: 9.99,
  fee: 0.01, estimatedTime: 60, gasIncluded: true, raw: {},
}]);
const executeBestBridge = vi.fn();
vi.mock("../bridge-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge-engine.js")>()),
  getAllQuotes: (...a: unknown[]) => getAllQuotes(...(a as [])),
  executeBestBridge: (...a: unknown[]) => executeBestBridge(...a),
  // No RPC in unit tests: the gas preflight is answered locally.
  checkBridgeGasBalance: async () => ({ ok: true, errors: [] }),
}));

const { addRootSafetyOptions } = await import("../cli-flags.js");
const { registerFundsCommands } = await import("../commands/funds.js");

function program(): Command {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog).option("--json");
  const noAdapter = async () => { throw new Error("adapter must not be built"); };
  registerFundsCommands(prog, noAdapter, () => true, () => "mainnet", noAdapter);
  return prog;
}

describe("funds bridge send --dry-run with explicit addresses loads no key (L3)", () => {
  it("returns the quote plan with sent:false and never calls loadPrivateKey", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program().parseAsync([
      "node", "perp", "--dry-run", "--json", "funds", "bridge", "send",
      "--from", "arbitrum", "--to", "base", "--amount", "10",
      "--sender", "0x0000000000000000000000000000000000000001",
      "--recipient", "0x0000000000000000000000000000000000000002",
    ]);
    vi.restoreAllMocks();
    const env = JSON.parse(out.find((l) => l.includes('"ok"'))!);
    expect(env.data).toMatchObject({ dryRun: true, sent: false, selected: "cctp" });
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(executeBestBridge).not.toHaveBeenCalled();
    expect(getAllQuotes).toHaveBeenCalledWith("arbitrum", "base", "10", "0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002");
  });
});

describe("funds bridge send (legacy raw-key path): own-address rule on a live bridge", () => {
  const KEY = `0x${"42".repeat(32)}`;
  const OWN = new Wallet(KEY).address;
  const OTHER = "0x000000000000000000000000000000000000dEaD";
  const live = async (extra: string[], result?: Record<string, unknown>) => {
    loadPrivateKey.mockImplementation(async () => KEY);
    executeBestBridge.mockReset();
    if (result !== undefined) executeBestBridge.mockResolvedValueOnce(result);
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return await program().parseAsync(["node", "perp", "--json", "funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "10", ...extra]).then(() => null, (e: unknown) => e);
    } finally {
      vi.restoreAllMocks();
    }
  };

  it("--recipient other than this wallet's own destination address → POLICY_DENIED, nothing is executed", async () => {
    const err = await live(["--recipient", OTHER]) as { structured: { code: string; remediation: string }; message: string };
    expect(err.structured.code).toBe("POLICY_DENIED");
    expect(err.message).toContain(OWN);
    expect(err.message).toContain("Nothing was sent");
    expect(err.structured.remediation).toContain("Omit --recipient");
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it("--sender other than this wallet's own source address → POLICY_DENIED, nothing is executed", async () => {
    const err = await live(["--sender", OTHER]) as { structured: { code: string } };
    expect(err.structured.code).toBe("POLICY_DENIED");
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it("naming the wallet's own address (any letter case) passes the rule", async () => {
    const err = await live(["--recipient", OWN.toLowerCase(), "--sender", OWN], { provider: "cctp", txHash: "0xabc" });
    expect(err).toBeNull();
    expect(executeBestBridge).toHaveBeenCalledTimes(1);
    expect(executeBestBridge.mock.calls[0].slice(5, 7)).toEqual([OWN, OWN.toLowerCase()]);
  });
});
