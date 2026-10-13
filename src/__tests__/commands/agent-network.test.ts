/**
 * Agent approve / revoke / rotate / verify resolve endpoints, signing chain
 * and EIP-712 fields from the selected network (-n). Regression for the bug
 * where `perp -n testnet wallet agent approve <aster|hyperliquid|pacifica>`
 * signed and submitted on MAINNET.
 *
 * Nothing is sent to a real venue: fetch and the OWS vault are mocked, and
 * assertions read the request URL / signed payload instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const TEST_HOME = resolve(os.tmpdir(), `perp-agent-network-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

const EVM_AGENT = "0xAgentNetAddr0000000000000000000000000001";
const EVM_MASTER = "0xMasterNetAddr000000000000000000000000001";
const SOL_AGENT = "AgentNetBase58Address111111111111111111111111";
const SOL_MASTER = "MasterNetBase58Address11111111111111111111111";

const AGENT_WALLET = {
  id: "wallet-agent-id",
  name: "agent",
  accounts: [
    { chainId: "eip155:1", address: EVM_AGENT, derivationPath: "m/44'/60'/0'/0/0" },
    { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_AGENT, derivationPath: "m/44'/501'/0'/0'" },
  ],
  createdAt: new Date().toISOString(),
};
const MASTER_WALLET = {
  id: "wallet-master-id",
  name: "main",
  accounts: [
    { chainId: "eip155:1", address: EVM_MASTER, derivationPath: "m/44'/60'/0'/0/0" },
    { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_MASTER, derivationPath: "m/44'/501'/0'/0'" },
  ],
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
const { resolveCredentials, NO_CLI_CREDENTIAL_OPTS } = await import("../../config.js");
import type { AgentMeta } from "../../settings.js";

function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride();
  // Mirrors the root program's global flag (src/index.ts).
  addRootSafetyOptions(prog);
  registerWalletAgentCommands(prog.command("wallet"), () => true);
  return prog;
}

function okFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

let stdout: string[];

/** Run a CLI line; returns the parsed JSON error envelope when the command exits non-zero, else null. */
async function run(args: string[]): Promise<{ code: string; message: string } | null> {
  try {
    await makeProgram().parseAsync(["node", "perp", ...args]);
    return null;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    const line = stdout.reverse().find(l => l.includes('"ok":false'));
    if (line === undefined) throw new Error("process.exit without an error envelope");
    return JSON.parse(line).error;
  }
}

/** Parsed EIP-712 typed data handed to the OWS vault for the n-th signTypedData call. */
function signedTypedData(n: number): { domain: Record<string, unknown>; message: Record<string, unknown> } {
  return JSON.parse(mockOws.signTypedData.mock.calls[n][2] as string);
}

function meta(venue: string, name: string, network: "mainnet" | "testnet" | undefined, extra: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agentName: name,
    agentWalletName: `agent-${venue}-main`,
    agentEvmAddress: EVM_AGENT as `0x${string}`,
    userEvmAddress: EVM_MASTER as `0x${string}`,
    agentSolanaAddress: SOL_AGENT,
    masterWalletName: "main",
    owsApiKeyId: "",
    owsPolicyId: "",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1",
    status: "active",
    ...(network !== undefined ? { network } : {}),
    ...extra,
  };
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  mockOws.createWallet.mockReturnValue(AGENT_WALLET);
  mockOws.getWallet.mockReturnValue(MASTER_WALLET);
  mockOws.signTypedData.mockReturnValue({ signature: "0x" + SIG_RS, recoveryId: 0 });
  mockOws.signMessage.mockReturnValue({ signature: "0x" + SIG_RS, recoveryId: 0 });
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
});

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Hyperliquid ──────────────────────────────────────────────────────────────

describe("Hyperliquid approveAgent follows -n", () => {
  it.each([
    ["mainnet", [], "https://api.hyperliquid.xyz/exchange", "Mainnet", "0xa4b1", 42161, "perp-cli-hl", "agent-hl-main"],
    ["testnet", ["-n", "testnet"], "https://api.hyperliquid-testnet.xyz/exchange", "Testnet", "0x66eee", 421614, "perp-cli-hl-tn", "agent-hl-main-testnet"],
  ] as const)("%s: URL, hyperliquidChain, signatureChainId, domain chainId, stored network", async (net, flag, url, chain, sigHex, chainId, name, wallet) => {
    const fetchMock = okFetch({ status: "ok" });
    const err = await run([...flag, "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.action).toMatchObject({ type: "approveAgent", hyperliquidChain: chain, signatureChainId: sigHex, agentName: expect.stringMatching(new RegExp(`^${name} valid_until \\d{13}$`)) });

    const td = signedTypedData(0);
    expect(td.domain).toMatchObject({ name: "HyperliquidSignTransaction", chainId });
    expect(td.message.hyperliquidChain).toBe(chain);

    expect(mockOws.createWallet).toHaveBeenCalledWith(wallet, "");
    const saved = store.getAgent("hyperliquid", name);
    expect(saved?.network).toBe(net);
  });

  it("revoke of a testnet agent signs Testnet and posts to the testnet host", async () => {
    store.setAgent("hyperliquid", meta("hl", "t1", "testnet"));
    const fetchMock = okFetch({ status: "ok" });
    const err = await run(["-n", "testnet", "wallet", "agent", "revoke", "hyperliquid", "t1", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.action).toMatchObject({ hyperliquidChain: "Testnet", signatureChainId: "0x66eee" });
    expect(signedTypedData(0).domain.chainId).toBe(421614);
    expect(store.getAgent("hyperliquid", "t1")).toBeNull();
  });

  it("refuses to revoke a mainnet agent from a testnet run (nothing signed or sent, record kept)", async () => {
    store.setAgent("hyperliquid", meta("hl", "m1", "mainnet"));
    const fetchMock = okFetch({ status: "ok" });
    const err = await run(["-n", "testnet", "wallet", "agent", "revoke", "hyperliquid", "m1", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("AGENT_NOT_REGISTERED");
    expect(err?.message).toContain("registered on mainnet, not testnet");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOws.signTypedData).not.toHaveBeenCalled();
    expect(store.getAgent("hyperliquid", "m1")).not.toBeNull();
  });

  it("refuses to rotate a mainnet agent from a testnet run", async () => {
    store.setAgent("hyperliquid", meta("hl", "m1", "mainnet"));
    const fetchMock = okFetch({ status: "ok" });
    const err = await run(["-n", "testnet", "wallet", "agent", "rotate", "hyperliquid", "m1", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("AGENT_NOT_REGISTERED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOws.createWallet).not.toHaveBeenCalled();
  });

  it("refuses to reuse a mainnet agent's name for a testnet approve", async () => {
    store.setAgent("hyperliquid", meta("hl", "shared", "mainnet"));
    const fetchMock = okFetch({ status: "ok" });
    const err = await run(["-n", "testnet", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--agent-name", "shared", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("INVALID_PARAMS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getAgent("hyperliquid", "shared")?.network).toBe("mainnet");
  });

  it("verify -n testnet queries the testnet /info with the testnet agent's master", async () => {
    store.setAgent("hyperliquid", meta("hl", "m1", "mainnet", { userEvmAddress: "0x00000000000000000000000000000000000000aa" }));
    store.setAgent("hyperliquid", meta("hl", "t1", "testnet", { userEvmAddress: "0x00000000000000000000000000000000000000bb" }));
    const fetchMock = okFetch([]);
    const err = await run(["-n", "testnet", "wallet", "agent", "verify", "hyperliquid", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hyperliquid-testnet.xyz/info");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).user).toBe("0x00000000000000000000000000000000000000bb");
  });
});

// ── Pacifica ─────────────────────────────────────────────────────────────────

describe("Pacifica bind/revoke/verify follow -n", () => {
  it.each([
    ["mainnet", [], "https://api.pacifica.fi/api/v1/agent/bind", "agent-pac-main"],
    ["testnet", ["-n", "testnet"], "https://test-api.pacifica.fi/api/v1/agent/bind", "agent-pac-main-testnet"],
  ] as const)("%s approve posts to the network host and records the network", async (net, flag, url, wallet) => {
    const fetchMock = okFetch({ success: true });
    const err = await run([...flag, "wallet", "agent", "approve", "pacifica", "--master", "main", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ type: "bind_agent_wallet", agent_wallet: SOL_AGENT });
    expect(mockOws.createWallet).toHaveBeenCalledWith(wallet, "");
    expect(store.getAgentForNetwork("pacifica", net)?.network).toBe(net);
  });

  it("testnet revoke posts to the testnet host", async () => {
    store.setAgent("pacifica", meta("pac", "t1", "testnet"));
    const fetchMock = okFetch({ success: true });
    const err = await run(["-n", "testnet", "wallet", "agent", "revoke", "pacifica", "t1", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("https://test-api.pacifica.fi/api/v1/agent/revoke");
  });

  it("testnet verify queries the testnet host", async () => {
    const fetchMock = okFetch({ success: true, data: [] });
    const err = await run(["-n", "testnet", "wallet", "agent", "verify", "pacifica", "--master", "main", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("https://test-api.pacifica.fi/api/v1/agent/list");
  });
});

// ── Aster ────────────────────────────────────────────────────────────────────

describe("Aster testnet: approve via registerAndApproveAgent; revoke/rotate CAPABILITY_UNSUPPORTED, never mainnet", () => {
  it("approve -n testnet POSTs registerAndApproveAgent on the testnet host with a Message{msg} signature", async () => {
    mockOws.createApiKey.mockReturnValue({ id: "key-1", token: "never-stored" });
    const fetchMock = okFetch({ code: 200, msg: "success" });
    const err = await run(["-n", "testnet", "wallet", "agent", "approve", "aster", "--master", "main", "--agent-name", "tn1", "--expires-in", "30d", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://fapi.asterdex-testnet.com/fapi/v3/registerAndApproveAgent");
    const q = url.searchParams;
    expect([...q.keys()]).toEqual(["user", "nonce", "agentName", "agentAddress", "expired", "signatureChainId", "canSpotTrade", "canPerpTrade", "canWithdraw", "ipWhitelist", "signature"]);
    expect(q.get("asterChain")).toBeNull();
    expect(q.get("signatureChainId")).toBe("56");
    const td = JSON.parse(mockOws.signTypedData.mock.calls[0][2] as string);
    expect(td.primaryType).toBe("Message");
    expect(td.domain).toMatchObject({ name: "AsterSignTransaction", version: "1", chainId: 56 });
    expect(td.message.msg).toBe(
      `user=${q.get("user")}&nonce=${q.get("nonce")}&agentName=tn1&agentAddress=${q.get("agentAddress")}&expired=${q.get("expired")}` +
      `&signatureChainId=56&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=`,
    );
    expect(store.getAgent("aster", "tn1")?.network).toBe("testnet");
  });

  it("approve -n testnet --can-withdraw without --ip-whitelist is refused before anything is created", async () => {
    const fetchMock = okFetch({ code: 200 });
    const err = await run(["-n", "testnet", "wallet", "agent", "approve", "aster", "--master", "main", "--can-withdraw", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("INVALID_PARAMS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOws.createWallet).not.toHaveBeenCalled();
  });

  it("approve -n testnet --can-withdraw signs a space-delimited ipWhitelist", async () => {
    mockOws.createApiKey.mockReturnValue({ id: "key-1", token: "never-stored" });
    const fetchMock = okFetch({ code: 200, msg: "success" });
    const err = await run(["-n", "testnet", "wallet", "agent", "approve", "aster", "--master", "main", "--agent-name", "tn2", "--can-withdraw", "--ip-whitelist", "1.2.3.4,10.0.0.0/24", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("ipWhitelist")).toBe("1.2.3.4 10.0.0.0/24");
    const td = JSON.parse(mockOws.signTypedData.mock.calls[0][2] as string);
    expect(td.message.msg).toContain("&canWithdraw=true&ipWhitelist=1.2.3.4 10.0.0.0/24");
  });

  it("approve -n testnet surfaces a venue rejection as APPROVE_PARTIAL and rolls back the agent wallet", async () => {
    mockOws.createApiKey.mockReturnValue({ id: "key-1", token: "never-stored" });
    okFetch({ code: -1022, msg: "Signature for this request is not valid." });
    const err = await run(["-n", "testnet", "wallet", "agent", "approve", "aster", "--master", "main", "--agent-name", "tn3", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("APPROVE_PARTIAL");
    expect(err?.message).toContain("registerAndApproveAgent");
    expect(store.getAgent("aster", "tn3")).toBeNull();
  });

  it.each(["revoke", "rotate"])("%s -n testnet signs and sends nothing", async (cmd) => {
    store.setAgent("aster", meta("aster", "a1", "mainnet"));
    const fetchMock = okFetch({ code: 200 });
    const err = await run(["-n", "testnet", "wallet", "agent", cmd, "aster", "a1", "--passphrase", "pp", "--json"]);
    expect(err?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getAgent("aster", "a1")).not.toBeNull();
  });

  it("mainnet approve posts to the mainnet host with AsterChain=Mainnet and records network", async () => {
    mockOws.createApiKey.mockReturnValue({ id: "key-1", token: "never-stored" });
    const fetchMock = okFetch({ code: "000000" });
    const err = await run(["wallet", "agent", "approve", "aster", "--master", "main", "--agent-name", "a1", "--expires-in", "30d", "--passphrase", "pp", "--json"]);
    expect(err).toBeNull();
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://fapi.asterdex.com/fapi/v3/approveAgent");
    expect(url.searchParams.get("asterChain")).toBe("Mainnet");
    expect(url.searchParams.get("signatureChainId")).toBe("56");
    expect(signedTypedData(0).message.AsterChain).toBe("Mainnet");
    expect(store.getAgent("aster", "a1")?.network).toBe("mainnet");
  });
});

// ── Network flag / stored-agent selection ────────────────────────────────────

describe("network selection safety", () => {
  it("rejects an unknown -n value before signing anything", async () => {
    const fetchMock = okFetch({ status: "ok" });
    // The root -n option is a validated choice: a typo is a usage error before any action runs.
    await expect(run(["-n", "tesnet", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--passphrase", "pp", "--json"]))
      .rejects.toThrow(/Allowed choices are mainnet, testnet/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOws.signTypedData).not.toHaveBeenCalled();
  });

  it("untagged aster/hl/pac records are mainnet (pre-fix approve was hardwired to mainnet)", () => {
    expect(store.agentNetworkOf("hyperliquid", meta("hl", "old", undefined))).toBe("mainnet");
    expect(store.agentNetworkOf("pacifica", meta("pac", "old", undefined))).toBe("mainnet");
    expect(store.agentNetworkOf("aster", meta("aster", "old", undefined))).toBe("mainnet");
  });

  it("untagged Lighter records cannot be classified and throw (approve always honored -n)", () => {
    expect(() => store.agentNetworkOf("lighter", meta("lt", "old", undefined))).toThrow(/no recorded network/);
  });

  it("resolveCredentials hands an adapter only the agent registered on its network", async () => {
    store.setAgent("hyperliquid", meta("hl", "m1", "mainnet"));
    store.setAgent("hyperliquid", meta("hl", "t1", "testnet"));
    const main = await resolveCredentials("hyperliquid", NO_CLI_CREDENTIAL_OPTS, "mainnet");
    const test = await resolveCredentials("hyperliquid", NO_CLI_CREDENTIAL_OPTS, "testnet");
    expect(main.agent?.agentName).toBe("m1");
    expect(test.agent?.agentName).toBe("t1");
    store.deleteAgent("hyperliquid", "t1");
    expect((await resolveCredentials("hyperliquid", NO_CLI_CREDENTIAL_OPTS, "testnet")).agent).toBeNull();
  });

  it("an adapter refuses an agent from another network (unless --no-agent)", async () => {
    const { createPacifica } = await import("../../exchanges/venues/create-helpers.js");
    const credentials = { pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: meta("pac", "m1", "mainnet") };
    await expect(createPacifica({ network: "testnet", credentials, noAgent: false, hlDex: null, readOnly: false, noBuilder: false }))
      .rejects.toMatchObject({ structured: { code: "AGENT_NOT_REGISTERED" } });
    await expect(createPacifica({ network: "testnet", credentials, noAgent: true, hlDex: null, readOnly: false, noBuilder: false })).resolves.toBeDefined();
  });
});
