/**
 * `funds withdraw hyperliquid --to` and `funds transfer <amount> <destination>` (HL usdSend):
 * owner-only unless the destination passes settings.withdraw.hyperliquid (the QFEX gate
 * mechanism: allowlist + maxPerTx / maxPerDay, src/withdraw-gate.ts). Dry runs show the verdict.
 * No network: the Hyperliquid adapter is a fake; HOME is isolated by the vitest setup file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  requireMasterWallet: vi.fn(async () => undefined),
}));

const { addRootSafetyOptions } = await import("../cli-flags.js");
const { registerFundsCommands } = await import("../commands/funds.js");
const { PerpError } = await import("../errors.js");

const OWNER = "0x00000000000000000000000000000000000000a1";
const ALLOWED = "0x00000000000000000000000000000000000000b2";
const STRANGER = "0x00000000000000000000000000000000000000c3";

const withdraw = vi.fn(async (_amount: string, _dest: string): Promise<unknown> => ({ status: "ok" }));
const usdTransfer = vi.fn(async (_amount: number, _dest: string): Promise<unknown> => ({ status: "ok" }));
const fakeHl = { address: OWNER, withdraw, usdTransfer, getBalance: async () => ({ available: "1000" }) };

function program(): Command {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog).option("--json").option("-e, --exchange <ex>");
  const adapterFor = async (ex: string) => {
    if (ex !== "hyperliquid") throw new Error(`unexpected adapter ${ex}`);
    return fakeHl as never;
  };
  registerFundsCommands(prog, async () => { throw new Error("no default adapter"); }, () => true, () => "mainnet", adapterFor);
  return prog;
}

let out: string[];
beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { throw new Error(`unexpected network call ${String(u)}`); }));
  writeSettings({});
  const ledger = resolve(process.env.HOME as string, ".perp", "withdraw-ledger.json");
  if (existsSync(ledger)) writeFileSync(ledger, "[]");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(resolve(process.env.HOME as string, ".perp"), { recursive: true });
  writeFileSync(resolve(process.env.HOME as string, ".perp", "settings.json"), JSON.stringify(obj));
}
const gate = (maxPerTx = 100, maxPerDay = 150) => writeSettings({ withdraw: { hyperliquid: { allowlist: [ALLOWED], maxPerTx, maxPerDay } } });
const ledger = (): Array<{ venue: string; to: string; amount: string }> => {
  const p = resolve(process.env.HOME as string, ".perp", "withdraw-ledger.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : [];
};

const run = (args: string[]) => program().parseAsync(["node", "perp", "--json", ...args]).then(() => null, (e: unknown) => e);
const lastJson = () => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);
const codeOf = (e: unknown) => (e instanceof PerpError ? e.structured.code : `not a PerpError: ${String(e)}`);

describe("funds withdraw hyperliquid", () => {
  it("withdraws to the owner without any gate (no ledger entry)", async () => {
    expect(await run(["funds", "withdraw", "hyperliquid", "10"])).toBeNull();
    expect(withdraw).toHaveBeenCalledWith("10", OWNER, { chain: "arbitrum" }); // CCTP, default destination chain
    expect(ledger()).toEqual([]);
  });

  it("refuses a non-owner --to without settings withdraw.hyperliquid (nothing sent)", async () => {
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "10", "--to", STRANGER]))).toBe("POLICY_DENIED");
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("refuses a non-allowlisted --to and an amount over maxPerTx even with a gate", async () => {
    gate();
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "10", "--to", STRANGER]))).toBe("POLICY_DENIED");
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "101", "--to", ALLOWED]))).toBe("POLICY_DENIED");
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("sends to an allowlisted --to and records it against maxPerDay", async () => {
    gate();
    expect(await run(["funds", "withdraw", "hyperliquid", "100", "--to", ALLOWED])).toBeNull();
    expect(withdraw).toHaveBeenCalledWith("100", ALLOWED, { chain: "arbitrum" });
    expect(ledger()).toMatchObject([{ venue: "hyperliquid", to: ALLOWED, amount: "100" }]);
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "60", "--to", ALLOWED]))).toBe("POLICY_DENIED"); // 160 > 150/day
  });

  it("a definite refusal by the venue is removed from the ledger", async () => {
    gate();
    withdraw.mockRejectedValueOnce(new PerpError("ACTION_REJECTED", "rejected"));
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "10", "--to", ALLOWED]))).toBe("ACTION_REJECTED");
    expect(ledger()).toEqual([]);
  });

  it("an unknown outcome stays in the ledger", async () => {
    gate();
    withdraw.mockRejectedValueOnce(new PerpError("ORDER_PENDING", "unknown"));
    expect(codeOf(await run(["funds", "withdraw", "hyperliquid", "10", "--to", ALLOWED]))).toBe("ORDER_PENDING");
    expect(ledger()).toHaveLength(1);
  });

  it("--dry-run shows the gate verdict and sends nothing", async () => {
    expect(await run(["--dry-run", "funds", "withdraw", "hyperliquid", "10"])).toBeNull();
    expect(lastJson().data.withdrawGate).toMatch(/not needed/);
    expect(await run(["--dry-run", "funds", "withdraw", "hyperliquid", "10", "--to", STRANGER])).toBeNull();
    expect(lastJson().data.withdrawGate).toMatch(/^would refuse/);
    gate();
    expect(await run(["--dry-run", "funds", "withdraw", "hyperliquid", "10", "--to", ALLOWED])).toBeNull();
    expect(lastJson().data.withdrawGate).toMatch(/^passes/);
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe("funds transfer (Hyperliquid usdSend)", () => {
  it("refuses any destination without the gate, and a non-allowlisted one with it", async () => {
    expect(codeOf(await run(["funds", "transfer", "10", STRANGER]))).toBe("POLICY_DENIED");
    gate();
    expect(codeOf(await run(["funds", "transfer", "10", STRANGER]))).toBe("POLICY_DENIED");
    expect(usdTransfer).not.toHaveBeenCalled();
  });

  it("sends to an allowlisted destination and records the attempt", async () => {
    gate();
    expect(await run(["funds", "transfer", "10", ALLOWED])).toBeNull();
    expect(usdTransfer).toHaveBeenCalledWith(10, ALLOWED);
    expect(ledger()).toMatchObject([{ venue: "hyperliquid", to: ALLOWED, amount: "10" }]);
  });

  it("--dry-run evaluates the gate (refuses like the live send; passes when allowlisted)", async () => {
    expect(codeOf(await run(["--dry-run", "funds", "transfer", "10", STRANGER]))).toBe("POLICY_DENIED");
    gate();
    expect(await run(["--dry-run", "funds", "transfer", "10", ALLOWED])).toBeNull();
    expect(lastJson().data).toMatchObject({ dryRun: true, sent: false, withdrawGate: expect.stringMatching(/^passes/) });
    expect(usdTransfer).not.toHaveBeenCalled();
  });
});
