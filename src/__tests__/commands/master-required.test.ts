/**
 * Master-only commands with no master wallet on this computer (e.g. only an agent / API key
 * imported from the exchange website): deposit, withdraw, transfer, bridge key loading fail up
 * front with NO_SIGNER_AVAILABLE + "do it on the website / import the master" — no adapter is
 * built and nothing is signed (never a fallback to the agent key). --dry-run still plans.
 *
 * Plus adapter wiring for imported agents without a master: reads use the master's public
 * address from the record, the agent key signs, Aster opens the imported wallet with "".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import type { AgentMeta } from "../../settings.js";

const HOME = process.env.HOME ?? "";

const { registerFundsCommands } = await import("../../commands/funds.js");
const { requireMasterWallet, loadPrivateKey, NO_CLI_CREDENTIAL_OPTS } = await import("../../config.js");
const { createHyperliquid, createLighterFamily, createAster } = await import("../../exchanges/venues/create-helpers.js");
const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
const { LighterAdapter } = await import("../../exchanges/lighter.js");
const { AsterAdapter } = await import("../../exchanges/aster.js");
const lighterKeystore = await import("../../agent-wallet/lighter-keystore.js");

const MASTER = "0x1111111111111111111111111111111111111111" as const;

function fundsProgram(getAdapter: () => Promise<never>): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.option("--dry-run");
  prog.option("--ows <name>");
  prog.option("-e, --exchange <venue>", "venue", "hyperliquid");
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerFundsCommands(prog, getAdapter, () => true, () => "mainnet", getAdapter);
  return prog;
}

function importedMeta(extra: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agentName: "web-x", agentWalletName: "agent-x-import-web-x", agentEvmAddress: "0x2222222222222222222222222222222222222222",
    userEvmAddress: MASTER, masterWalletName: "", owsApiKeyId: "", owsPolicyId: "", expiresAt: "", approvedAt: "2026-10-02T00:00:00.000Z",
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "", status: "active",
    network: "mainnet", source: "imported", ...extra,
  };
}

beforeEach(() => {
  expect(HOME).toContain("perp-cli-test-home-");
  rmSync(resolve(HOME, ".perp"), { recursive: true, force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { throw new Error(`unexpected fetch ${String(u)}`); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("master-only fund movements without a master wallet", () => {
  it.each([
    [["funds", "withdraw", "hyperliquid", "5"]],
    [["funds", "withdraw", "pacifica", "5"]],
    [["-e", "lighter", "funds", "withdraw", "lighter", "5"]],
    [["-e", "lighter-rh", "funds", "withdraw", "lighter", "5"]],
    [["funds", "transfer", "5", "0x3333333333333333333333333333333333333333"]],
    [["funds", "deposit", "pacifica", "20", "--no-relay"]],
    [["funds", "deposit", "hyperliquid", "20", "--no-relay"]],
    [["funds", "deposit", "lighter", "ethereum", "5"]],
  ])("%j → NO_SIGNER_AVAILABLE before any adapter / key", async (argv) => {
    const get = vi.fn(async () => { throw new Error("must not build an adapter"); });
    const err = await fundsProgram(get as never).parseAsync(argv, { from: "user" }).catch(e => e);
    expect(err.structured.code).toBe("NO_SIGNER_AVAILABLE");
    expect(err.structured.remediation).toMatch(/website/);
    expect(err.structured.remediation).toMatch(/perp wallet import/);
    expect(get).not.toHaveBeenCalled();
  });

  it("--dry-run still returns the plan without a master", async () => {
    const get = vi.fn(async () => { throw new Error("must not build an adapter"); });
    await fundsProgram(get as never).parseAsync(["--dry-run", "funds", "withdraw", "hyperliquid", "5"], { from: "user" });
    expect(get).not.toHaveBeenCalled();
  });

  it("requireMasterWallet passes when a master is selected (--ows), and loadPrivateKey (bridge) fails clearly without one", async () => {
    await expect(requireMasterWallet("hyperliquid", { ...NO_CLI_CREDENTIAL_OPTS, ows: "main" }, "x")).resolves.toBeUndefined();
    await expect(loadPrivateKey("hyperliquid")).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
  });
});

describe("adapter wiring for an imported agent with no master on this computer", () => {
  const ctx = (agent: AgentMeta) => ({
    network: "mainnet" as const,
    credentials: { pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: "ows_token_from_env", agent },
    noAgent: false, hlDex: null, readOnly: false, noBuilder: false,
  });

  it("Hyperliquid: account reads use the master address from the record; the agent tier signs", async () => {
    vi.spyOn(HyperliquidAdapter.prototype, "init").mockResolvedValue(undefined);
    const ows = await import("../../signer/ows-evm.js");
    vi.spyOn(ows.OwsEvmSigner, "create").mockReturnValue({ getAddress: () => "0x2222222222222222222222222222222222222222" } as never);
    const a = await createHyperliquid(ctx(importedMeta())) as InstanceType<typeof HyperliquidAdapter>;
    expect(a.address).toBe(MASTER);
    expect(a.activeSignerTier).toBe("agent");
  });

  it("Hyperliquid: a loaded master that is NOT the imported agent's master is refused (no mixed accounts)", async () => {
    vi.spyOn(HyperliquidAdapter.prototype, "init").mockResolvedValue(undefined);
    const ows = await import("../../signer/ows-evm.js");
    vi.spyOn(ows.OwsEvmSigner, "create").mockReturnValue({ getAddress: () => "0x4444444444444444444444444444444444444444" } as never);
    const c = ctx(importedMeta());
    await expect(createHyperliquid({ ...c, credentials: { ...c.credentials, owsWallet: "other", owsPassphrase: "" } }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("Lighter: the owner L1 address is set without a signer; the keystore key is loaded", async () => {
    vi.spyOn(LighterAdapter.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(lighterKeystore, "loadLighterFamilyKey").mockReturnValue("ab".repeat(40));
    const a = await createLighterFamily("lighter", ctx(importedMeta({ accountIndex: 7, apiKeyIndex: 6 }))) as InstanceType<typeof LighterAdapter>;
    expect(a.address).toBe(MASTER);
    await expect(a.signL1Transaction({} as never)).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
  });

  it("Aster: an imported agent wallet is opened with an empty passphrase (never the OWS API token)", async () => {
    vi.spyOn(AsterAdapter.prototype, "init").mockResolvedValue(undefined);
    const strat = await import("../../agent-wallet/signing-strategy.js");
    const spy = vi.spyOn(strat, "agentSigningStrategyFor");
    await createAster(ctx(importedMeta()));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ source: "imported" }), "");
  });
});
