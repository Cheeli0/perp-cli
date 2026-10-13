/**
 * Agent revoke / rotate must never treat a failed or unknown venue revoke as
 * success, and `wallet agent list` reports each agent's network.
 *
 * - Hyperliquid revoke: a non-ok / unparseable / rejected response throws
 *   APPROVE_FAILED ("may still be authorized") and keeps the local record.
 * - Aster rotate: the DELETE /fapi/v3/agent response is checked; on failure the
 *   rotate aborts BEFORE approving a new agent, keeping the old record.
 * - list: `network` column / JSON field (null = untagged, unclassifiable).
 *
 * Nothing reaches a real venue: fetch and the OWS vault are mocked. HOME is
 * isolated by src/__tests__/helpers/isolate-home.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const EVM_AGENT = "0xAgentFailAddr000000000000000000000000001";
const EVM_MASTER = "0xMasterFailAddr00000000000000000000000001";

const AGENT_WALLET = {
  id: "wallet-agent-id",
  name: "agent",
  accounts: [{ chainId: "eip155:1", address: "0xNewAgentAddr0000000000000000000000000002", derivationPath: "m/44'/60'/0'/0/0" }],
  createdAt: new Date().toISOString(),
};
const MASTER_WALLET = {
  id: "wallet-master-id",
  name: "main",
  accounts: [{ chainId: "eip155:1", address: EVM_MASTER, derivationPath: "m/44'/60'/0'/0/0" }],
  createdAt: new Date().toISOString(),
};

// Canonical r||s of a valid secp256k1 signature (ethers.Signature.from needs low-s).
const SIG_RS = "1aee1548148536475582711c39958806646195b294c0bbc0d52ed8aae7798817" +
  "5240c82244cf8e1e0d4387d107ef558090bae5d6a603235750e93ee0be1b1bbf";

const mockOws = {
  listWallets: vi.fn((): Array<{ name: string }> => []),
  createWallet: vi.fn(),
  createPolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  deleteWallet: vi.fn(),
  getWallet: vi.fn(),
  signTypedData: vi.fn(),
  signMessage: vi.fn(),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(), close: vi.fn() })),
}));

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const store = await import("../../agent-wallet/store.js");
import type { AgentMeta } from "../../settings.js";

function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog);
  registerWalletAgentCommands(prog.command("wallet"), () => true);
  return prog;
}

interface FakeRes { ok: boolean; status: number; body: string }
function stubFetch(...responses: Array<FakeRes | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce({ ok: r.ok, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

let stdout: string[];

async function run(args: string[]): Promise<{ code: string; message: string; remediation?: string } | null> {
  try {
    await makeProgram().parseAsync(["node", "perp", ...args]);
    return null;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    const line = [...stdout].reverse().find(l => l.includes('"ok":false'));
    if (line === undefined) throw new Error("process.exit without an error envelope");
    return JSON.parse(line).error;
  }
}

/** `data` of the success envelope printed by the command (pretty-printed JSON), or null if none. */
function okData(): unknown {
  for (const chunk of stdout) {
    try {
      const parsed = JSON.parse(chunk) as { ok?: unknown; data?: unknown };
      if (parsed.ok === true) return parsed.data;
    } catch { /* not a JSON chunk */ }
  }
  return null;
}

function meta(name: string, extra: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agentName: name,
    agentWalletName: "agent-x-main",
    agentEvmAddress: EVM_AGENT as `0x${string}`,
    userEvmAddress: EVM_MASTER as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: "",
    owsPolicyId: "",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    approvedAt: "2026-01-01T00:00:00.000Z",
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1",
    status: "active",
    network: "mainnet",
    ...extra,
  };
}

beforeEach(() => {
  rmSync(resolve(process.env.HOME as string, ".perp", "settings.json"), { force: true });
  vi.clearAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  mockOws.createWallet.mockReturnValue(AGENT_WALLET);
  mockOws.createApiKey.mockReturnValue({ id: "key-new", token: "ows_key_NEVER_STORED", name: "k" });
  mockOws.getWallet.mockReturnValue(MASTER_WALLET);
  mockOws.signTypedData.mockReturnValue({ signature: "0x" + SIG_RS, recoveryId: 0 });
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. Hyperliquid revoke ────────────────────────────────────────────────────

describe("Hyperliquid revoke surfaces a failed / unknown revoke", () => {
  it.each([
    ["status:err", { ok: true, status: 200, body: JSON.stringify({ status: "err", response: "User or API Wallet does not exist." }) }],
    ["HTTP 500", { ok: false, status: 500, body: "internal error" }],
    ["unparseable body", { ok: true, status: 200, body: "<html>bad gateway</html>" }],
    ["no status field", { ok: true, status: 200, body: JSON.stringify({ response: "?" }) }],
  ] as const)("%s → APPROVE_FAILED, record and keys kept", async (_label, res) => {
    store.setAgent("hyperliquid", meta("hl1"));
    stubFetch(res);
    const err = await run(["wallet", "agent", "revoke", "hyperliquid", "hl1", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("APPROVE_FAILED");
    expect(err?.remediation).toContain("may still be authorized");
    expect(store.getAgent("hyperliquid", "hl1")).not.toBeNull();
    expect(mockOws.deleteWallet).not.toHaveBeenCalled();
    expect(okData()).toBeNull();
  });

  it("network error → error surfaced, record kept", async () => {
    store.setAgent("hyperliquid", meta("hl1"));
    stubFetch(new Error("ECONNRESET"));
    const err = await run(["wallet", "agent", "revoke", "hyperliquid", "hl1", "--passphrase", "pp", "--json"]);
    expect(err).not.toBeNull();
    expect(store.getAgent("hyperliquid", "hl1")).not.toBeNull();
  });

  it("status:ok → revoked under the agent's own name, record deleted", async () => {
    store.setAgent("hyperliquid", meta("hl1"));
    const fetchMock = stubFetch({ ok: true, status: 200, body: JSON.stringify({ status: "ok", response: { type: "default" } }) });
    const err = await run(["wallet", "agent", "revoke", "hyperliquid", "hl1", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.action).toMatchObject({
      type: "approveAgent",
      agentAddress: "0x0000000000000000000000000000000000000000",
      agentName: "hl1",
      hyperliquidChain: "Mainnet",
    });
    expect(store.getAgent("hyperliquid", "hl1")).toBeNull();
  });

  it("rotate aborts when the HL revoke fails — old record kept, no new agent approved", async () => {
    store.setAgent("hyperliquid", meta("hl1"));
    const fetchMock = stubFetch({ ok: true, status: 200, body: JSON.stringify({ status: "err", response: "nope" }) });
    const err = await run(["wallet", "agent", "rotate", "hyperliquid", "hl1", "--master", "main", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("APPROVE_FAILED");
    expect(err?.remediation).toMatch(/may still be authorized|kept/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(store.getAgent("hyperliquid", "hl1")?.agentEvmAddress).toBe(EVM_AGENT);
  });
});

// ── 2. Aster rotate ──────────────────────────────────────────────────────────

describe("Aster rotate checks the delete-agent response", () => {
  const rotate = ["wallet", "agent", "rotate", "aster", "a1", "--master", "main", "--passphrase", "pp", "--json"];

  it.each([
    ["HTTP 400", { ok: false, status: 400, body: JSON.stringify({ code: -1022, msg: "Signature for this request is not valid." }) }],
    ["2xx with negative code", { ok: true, status: 200, body: JSON.stringify({ code: -1000, msg: "unknown agent" }) }],
  ] as const)("%s → APPROVE_FAILED, rotate aborted before approving, old record + OWS key kept", async (_label, res) => {
    store.setAgent("aster", meta("a1", { owsApiKeyId: "key-old", owsPolicyId: "pol-old" }));
    const fetchMock = stubFetch(res);
    const err = await run(rotate);
    expect(err?.code).toBe("APPROVE_FAILED");
    expect(err?.message).toContain("Aster agent delete");
    expect(err?.remediation).toContain("may still be authorized");
    expect(err?.remediation).toContain("no new agent was approved");
    // Only the DELETE was sent; no approve, no new OWS wallet / key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(mockOws.revokeApiKey).not.toHaveBeenCalled();
    const kept = store.getAgent("aster", "a1");
    expect(kept?.agentEvmAddress).toBe(EVM_AGENT);
    expect(kept?.owsApiKeyId).toBe("key-old");
    expect(okData()).toBeNull();
  });

  it("network error on DELETE → APPROVE_FAILED (old agent may still be authorized), record kept", async () => {
    store.setAgent("aster", meta("a1"));
    stubFetch(new Error("socket hang up"));
    const err = await run(rotate);
    expect(err?.code).toBe("APPROVE_FAILED");
    expect(err?.message).toContain("may still be authorized");
    expect(store.getAgent("aster", "a1")?.agentEvmAddress).toBe(EVM_AGENT);
  });

  it("404 (already deleted server-side) → rotate proceeds and approves the new agent", async () => {
    store.setAgent("aster", meta("a1", { owsApiKeyId: "key-old" }));
    const fetchMock = stubFetch(
      { ok: false, status: 404, body: "not found" },
      { ok: true, status: 200, body: JSON.stringify({ code: 200, msg: "success" }) },
      { ok: true, status: 200, body: JSON.stringify({ code: 200, msg: "success" }) },
    );
    const err = await run(rotate);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(mockOws.revokeApiKey).toHaveBeenCalledWith("key-old");
    expect(okData()).toMatchObject({ rotated: true, agentName: "a1" });
    expect(store.getAgent("aster", "a1")?.agentEvmAddress).toBe(AGENT_WALLET.accounts[0].address);
  });
});

// ── 6. list shows network ────────────────────────────────────────────────────

describe("wallet agent list reports each agent's network", () => {
  it("JSON carries network (null for an untagged, unclassifiable record)", async () => {
    store.setAgent("hyperliquid", meta("hl-main", { network: "mainnet" }));
    store.setAgent("hyperliquid", meta("hl-test", { network: "testnet" }));
    const untaggedHl = meta("hl-old");
    delete (untaggedHl as Partial<AgentMeta>).network;
    store.setAgent("hyperliquid", untaggedHl);
    const untaggedLt = meta("lt-old");
    delete (untaggedLt as Partial<AgentMeta>).network;
    store.setAgent("lighter", untaggedLt);

    const err = await run(["wallet", "agent", "list", "--json"]);
    expect(err).toBeNull();
    const rows = okData() as Array<{ name: string; network: string | null }>;
    const byName = Object.fromEntries(rows.map(r => [r.name, r.network]));
    expect(byName).toMatchObject({ "hl-main": "mainnet", "hl-test": "testnet", "hl-old": "mainnet", "lt-old": null });
  });

  it("table has a NETWORK column; unknown network printed as 'unknown'", async () => {
    store.setAgent("hyperliquid", meta("hl-test", { network: "testnet" }));
    const untaggedLt = meta("lt-old");
    delete (untaggedLt as Partial<AgentMeta>).network;
    store.setAgent("lighter", untaggedLt);

    const prog = new Command();
    prog.exitOverride();
    addRootSafetyOptions(prog);
    registerWalletAgentCommands(prog.command("wallet"), () => false);
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list"]);

    const out = stdout.join("\n");
    expect(out).toContain("NETWORK");
    expect(stdout.find(l => l.includes("hl-test"))).toContain("testnet");
    expect(stdout.find(l => l.includes("lt-old"))).toContain("unknown");
  });
});

// ── 3. rotate master resolution ──────────────────────────────────────────────

describe("rotate never builds an agent name from an empty master", () => {
  it.each(["aster", "hyperliquid", "pacifica", "lighter"])(
    "%s: no --master, no record master, no owsActiveWallet → INVALID_PARAMS before any revoke/sign",
    async (venue) => {
      const fetchMock = stubFetch();
      const err = await run(["wallet", "agent", "rotate", venue, "ghost", "--passphrase", "pp", "--json"]);
      expect(err?.code).toBe("INVALID_PARAMS");
      expect(err?.remediation).toContain("--master");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockOws.createWallet).not.toHaveBeenCalled();
      expect(mockOws.signTypedData).not.toHaveBeenCalled();
    },
  );

  it("hyperliquid: no --master, no owsActiveWallet → new agent wallet named after the old record's master", async () => {
    store.setAgent("hyperliquid", meta("hl1", { masterWalletName: "main" }));
    const okRes = { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", response: { type: "default" } }), json: async () => ({ status: "ok", response: { type: "default" } }) };
    vi.stubGlobal("fetch", vi.fn(async () => okRes));
    await run(["wallet", "agent", "rotate", "hyperliquid", "hl1", "--passphrase", "pp", "--json"]);
    expect(mockOws.createWallet).toHaveBeenCalled();
    const names = mockOws.createWallet.mock.calls.map(c => c[0] as string);
    expect(names).toContain("agent-hl-main");
    expect(names.some(n => n.endsWith("-"))).toBe(false);
  });
});
