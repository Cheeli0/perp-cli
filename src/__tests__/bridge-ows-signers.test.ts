/**
 * USDC bridge with an OWS master wallet (live bug 2026-10-13: `funds bridge send / exchange`
 * treated the "ows:<wallet>" reference as a raw key → `invalid BytesLike value "0xows:main"`).
 *
 *  - addresses come from the OWS vault's public account list — nothing is decrypted / signed
 *    (the fake vault throws on every signing call)
 *  - signer selection: OWS master → OwsEvmSigner / OwsSolanaSigner; raw-key master → local signers
 *  - typed PerpError codes: INVALID_PARAMS / NO_BRIDGE_ROUTE / INSUFFICIENT_BALANCE /
 *    NO_SIGNER_AVAILABLE / SIGNATURE_FAILED; ORDER_PENDING is logged "unverified", never "failed"
 *
 * Everything is mocked: no RPC, no quote API, no vault, nothing is sent anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { Wallet, Transaction, verifyTypedData } from "ethers";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const OWS_EVM = "0x1111111111111111111111111111111111111111";
const OWS_SOL = "So11111111111111111111111111111111111111112";

// ── Fake OWS vault: public accounts readable, every signing call refused ──
const owsSign = vi.fn((..._a: unknown[]) => { throw new Error("vault must not be opened (decrypt) in this test"); });
const fakeOws = {
  getWallet: vi.fn((name: string) => ({
    name,
    accounts: [
      { chainId: "eip155:1", address: OWS_EVM },
      { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: OWS_SOL },
    ],
  })),
  signHash: owsSign, signTransaction: owsSign, signMessage: owsSign, signTypedData: owsSign,
};
vi.mock("../signer/ows-loader.js", () => ({ loadOws: () => fakeOws }));

// ── Master selection: OWS by default; tests switch to a raw-key master ──
type OwsMaster = { wallet: string; passphrase: string } | null;
const resolveOwsMaster = vi.fn(async (): Promise<OwsMaster> => ({ wallet: "main", passphrase: "" }));
const loadPrivateKey = vi.fn(async (..._a: unknown[]): Promise<string> => { throw new Error("raw key must not be loaded for an OWS master"); });
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  resolveOwsMaster: (...a: unknown[]) => resolveOwsMaster(...(a as [])),
  loadPrivateKey: (...a: unknown[]) => loadPrivateKey(...a),
}));

type Quote = import("../bridge-engine.js").BridgeQuote;
const QUOTE = (src: string, dst: string, provider: Quote["provider"] = "cctp", gasIncluded = true): Quote => ({
  provider, srcChain: src, dstChain: dst, amountIn: 5, amountOut: 4.99, fee: 0.01, estimatedTime: 60, gasIncluded, raw: {},
});
const getAllQuotes = vi.fn(async (src: string, dst: string): Promise<Quote[]> => [QUOTE(src, dst)]);
const executeBestBridge = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ provider: "cctp", txHash: "0xabc", srcChain: "arbitrum", dstChain: "solana", amountIn: 5, amountOut: 4.99 }));
const checkBridgeGasBalance = vi.fn(async (..._a: unknown[]) => ({ ok: true, errors: [] as string[] }));
vi.mock("../bridge-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge-engine.js")>()),
  getAllQuotes: (...a: unknown[]) => getAllQuotes(...(a as [string, string])),
  executeBestBridge: (...a: unknown[]) => executeBestBridge(...a),
  checkBridgeGasBalance: (...a: unknown[]) => checkBridgeGasBalance(...a),
}));

const logExecution = vi.fn();
vi.mock("../execution-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution-log.js")>()),
  logExecution: (...a: unknown[]) => logExecution(...a),
}));

const { addRootSafetyOptions } = await import("../cli-flags.js");
const { registerFundsCommands } = await import("../commands/funds.js");
const { PerpError } = await import("../errors.js");
const { OwsEvmSigner } = await import("../signer/ows-evm.js");
const { OwsSolanaSigner } = await import("../signer/ows-solana.js");
const { LocalSolanaSigner } = await import("../signer/solana-local.js");
const signers = await import("../bridge-signers.js");
const engine = await vi.importActual<typeof import("../bridge-engine.js")>("../bridge-engine.js");
const { NO_CLI_CREDENTIAL_OPTS } = await import("../config.js");

function program(): Command {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog).option("--json");
  const noAdapter = async () => { throw new Error("adapter must not be built"); };
  registerFundsCommands(prog, noAdapter, () => true, () => "mainnet", noAdapter);
  return prog;
}

let out: string[];
const fetchSpy = vi.fn(async (url: unknown) => { throw new Error(`unexpected network call: ${String(url)}`); });
beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", fetchSpy);
  resolveOwsMaster.mockImplementation(async () => ({ wallet: "main", passphrase: "" }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = (args: string[]) => program().parseAsync(["node", "perp", "--json", ...args]).then(() => null, (e: unknown) => e);
const lastJson = () => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);
const codeOf = (e: unknown) => (e instanceof PerpError ? e.structured.code : `not a PerpError: ${String(e)}`);

// ── 1. Address resolution without decrypt ──

describe("OWS master: public addresses only, nothing decrypted", () => {
  it("bridgeAddress reads the vault account list (EVM + Solana), no signing call", async () => {
    expect(await signers.bridgeAddress("arbitrum", "hyperliquid", NO_CLI_CREDENTIAL_OPTS)).toBe(OWS_EVM);
    expect(await signers.bridgeAddress("solana", "pacifica", NO_CLI_CREDENTIAL_OPTS)).toBe(OWS_SOL);
    expect(owsSign).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
  });

  it("funds bridge send --dry-run arbitrum → solana quotes for the master's own addresses (the live bug)", async () => {
    expect(await run(["--dry-run", "funds", "bridge", "send", "--from", "arbitrum", "--to", "solana", "--amount", "5"])).toBeNull();
    expect(getAllQuotes).toHaveBeenCalledWith("arbitrum", "solana", 5, OWS_EVM, OWS_SOL);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, selected: "cctp" } });
    expect(owsSign).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(executeBestBridge).not.toHaveBeenCalled();
    expect(checkBridgeGasBalance).not.toHaveBeenCalled();
  });

  it("funds bridge exchange --dry-run hyperliquid → pacifica resolves both sides from the vault", async () => {
    expect(await run(["--dry-run", "funds", "bridge", "exchange", "--from", "hyperliquid", "--to", "pacifica", "--amount", "10"])).toBeNull();
    expect(getAllQuotes).toHaveBeenCalledWith("hyperliquid", "solana", 10, OWS_EVM, OWS_SOL);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false } });
    expect(owsSign).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
  });

  it("--json dry-run with a Relay quote (BigInt tx payloads) prints the step kinds instead of failing to serialize", async () => {
    getAllQuotes.mockImplementationOnce(async (s: string, d: string) => [{
      ...QUOTE(s, d, "relay"), raw: { requestId: "0xreq", txs: [{ kind: "approve", value: 0n }, { kind: "deposit", value: 1n }] },
    }]);
    expect(await run(["--dry-run", "funds", "bridge", "send", "--from", "arbitrum", "--to", "solana", "--amount", "5"])).toBeNull();
    expect(lastJson()).toMatchObject({ ok: true, data: { selected: "relay", quotes: [{ provider: "relay", raw: { requestId: "0xreq", steps: ["approve", "deposit"] } }] } });
  });

  it("funds bridge quote defaults sender / recipient to the master's own addresses", async () => {
    expect(await run(["funds", "bridge", "quote", "--from", "solana", "--to", "base", "--amount", "5"])).toBeNull();
    expect(getAllQuotes).toHaveBeenCalledWith("solana", "base", 5, OWS_SOL, OWS_EVM);
    expect(owsSign).not.toHaveBeenCalled();
  });

  it("an OWS wallet without a Solana account → NO_SIGNER_AVAILABLE before any quote", async () => {
    fakeOws.getWallet.mockImplementationOnce((name: string) => ({ name, accounts: [{ chainId: "eip155:1", address: OWS_EVM }] }));
    const err = await run(["--dry-run", "funds", "bridge", "send", "--from", "solana", "--to", "arbitrum", "--amount", "5"]);
    expect(codeOf(err)).toBe("NO_SIGNER_AVAILABLE");
    expect(getAllQuotes).not.toHaveBeenCalled();
  });
});

// ── 2. Signer selection (OWS vs raw key) ──

describe("signer selection", () => {
  const KEY = `0x${"42".repeat(32)}`;
  const SOL_KP = Keypair.fromSeed(new Uint8Array(32).fill(7));

  it("OWS master → OwsEvmSigner / OwsSolanaSigner (no decrypt at load)", async () => {
    const evm = await signers.loadBridgeSigner("arbitrum", "hyperliquid", NO_CLI_CREDENTIAL_OPTS);
    const sol = await signers.loadBridgeSigner("solana", "pacifica", NO_CLI_CREDENTIAL_OPTS);
    expect(evm).toBeInstanceOf(OwsEvmSigner);
    expect(sol).toBeInstanceOf(OwsSolanaSigner);
    expect((evm as import("../signer/ows-evm.js").OwsEvmSigner).getAddress()).toBe(OWS_EVM);
    expect((sol as import("../signer/ows-solana.js").OwsSolanaSigner).getPublicKeyBase58()).toBe(OWS_SOL);
    expect(owsSign).not.toHaveBeenCalled();
  });

  it("raw-key master → local signers (EVM SigningKey, Solana Keypair)", async () => {
    resolveOwsMaster.mockResolvedValue(null);
    loadPrivateKey.mockImplementation(async (venue: unknown) => (venue === "pacifica" ? bs58.encode(SOL_KP.secretKey) : KEY));
    const evm = await signers.loadBridgeSigner("base", "hyperliquid", NO_CLI_CREDENTIAL_OPTS);
    const sol = await signers.loadBridgeSigner("solana", "pacifica", NO_CLI_CREDENTIAL_OPTS);
    expect(signers.isBridgeEvmSigner(evm) && evm.getAddress()).toBe(new Wallet(KEY).address);
    expect(sol).toBeInstanceOf(LocalSolanaSigner);
    expect((sol as InstanceType<typeof LocalSolanaSigner>).getPublicKeyBase58()).toBe(SOL_KP.publicKey.toBase58());
    expect(await signers.bridgeAddress("arbitrum", "hyperliquid", NO_CLI_CREDENTIAL_OPTS)).toBe(new Wallet(KEY).address);
  });

  it("an 'ows:<wallet>' reference coming back as a key is refused (NO_SIGNER_AVAILABLE), never parsed", async () => {
    resolveOwsMaster.mockResolvedValue(null);
    loadPrivateKey.mockResolvedValue("ows:main");
    expect(codeOf(await signers.loadBridgeSigner("arbitrum", "hyperliquid", NO_CLI_CREDENTIAL_OPTS).catch(e => e))).toBe("NO_SIGNER_AVAILABLE");
  });

  it("live send hands the engine the OWS signers and the provider shown as selected", async () => {
    getAllQuotes.mockImplementationOnce(async (s: string, d: string) => [QUOTE(s, d, "relay"), QUOTE(s, d, "debridge")]);
    expect(await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "solana", "--amount", "5"])).toBeNull();
    expect(checkBridgeGasBalance).toHaveBeenCalledWith("arbitrum", OWS_EVM, "solana", OWS_SOL, false);
    expect(executeBestBridge).toHaveBeenCalledTimes(1);
    const a = executeBestBridge.mock.calls[0];
    expect(a[4]).toBeInstanceOf(OwsEvmSigner);
    expect(a.slice(5, 7)).toEqual([OWS_EVM, OWS_SOL]);
    expect(a[7]).toBeInstanceOf(OwsSolanaSigner);
    expect(a[8]).toBe("relay");
    expect(owsSign).not.toHaveBeenCalled(); // the engine is mocked: nothing signed
  });

  it("live send keeps the own-address rule for an OWS master (--recipient elsewhere → POLICY_DENIED)", async () => {
    const err = await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5", "--recipient", "0x000000000000000000000000000000000000dEaD"]);
    expect(codeOf(err)).toBe("POLICY_DENIED");
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it("engine refuses an 'ows:' string as a signer before any network call (EVM and Solana legs)", async () => {
    const evmQ = { ...QUOTE("arbitrum", "base", "debridge"), raw: { senderAddress: OWS_EVM, recipientAddress: OWS_EVM, amountRaw: "5000000" } };
    const solQ = { ...QUOTE("solana", "base", "debridge"), raw: { senderAddress: OWS_SOL, recipientAddress: OWS_EVM, amountRaw: "5000000" } };
    expect(codeOf(await engine.executeDebridgeBridge("mainnet", evmQ, "ows:main").catch(e => e))).toBe("NO_SIGNER_AVAILABLE");
    expect(codeOf(await engine.executeDebridgeBridge("mainnet", solQ, "ows:main").catch(e => e))).toBe("NO_SIGNER_AVAILABLE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("engine refuses a signer that is not the quoted sender (INVALID_PARAMS) before any network call", async () => {
    const q = { ...QUOTE("arbitrum", "base", "debridge"), raw: { senderAddress: OWS_EVM, recipientAddress: OWS_EVM, amountRaw: "5000000" } };
    expect(codeOf(await engine.executeDebridgeBridge("mainnet", q, signers.pkEvmSigner(KEY)).catch(e => e))).toBe("INVALID_PARAMS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HyperCore → EVM signs with a signer object (typed data checked) and posts once", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "ok", response: { type: "default" } }) });
    vi.stubGlobal("fetch", post);
    const signer = signers.pkEvmSigner(KEY);
    await engine.executeCctpBridge("mainnet", "hyperliquid", "arbitrum", 10, signer, signer.getAddress());
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(post.mock.calls[0][1].body as string).action).toMatchObject({ type: "sendToEvmWithData", destinationRecipient: signer.getAddress() });
  });

  it("HyperCore → EVM with a signer whose typed-data signature does not recover → SIGNATURE_FAILED, nothing posted", async () => {
    const post = vi.fn();
    vi.stubGlobal("fetch", post);
    const real = signers.pkEvmSigner(KEY);
    const other = signers.pkEvmSigner(`0x${"43".repeat(32)}`);
    const lying = { getAddress: real.getAddress, signTransaction: real.signTransaction, signTypedData: other.signTypedData };
    expect(codeOf(await engine.executeCctpBridge("mainnet", "hyperliquid", "arbitrum", 10, lying, real.getAddress()).catch(e => e))).toBe("SIGNATURE_FAILED");
    expect(post).not.toHaveBeenCalled();
  });

  it("pkEvmSigner: tx signature recovers to the key's address; typed data verifies", async () => {
    const s = signers.pkEvmSigner(KEY);
    const tx = Transaction.from({ chainId: 42161n, nonce: 0, to: OWS_EVM, data: "0x", value: 0n, gasLimit: 21000n, type: 2, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    tx.signature = await s.signTransaction(tx);
    expect(tx.from).toBe(s.getAddress());
    const domain = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: OWS_EVM };
    const types = { Ping: [{ name: "value", type: "uint256" }] };
    const sig = await s.signTypedData(domain, types, { value: "5" });
    expect(verifyTypedData(domain, types, { value: "5" }, sig)).toBe(s.getAddress());
  });

  it("signVersionedSolanaTx: vault-style bytes signer is attached only when the signature verifies", async () => {
    const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const build = () => new VersionedTransaction(new TransactionMessage({
      payerKey: owner.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)),
      instructions: [{ programId: new PublicKey("11111111111111111111111111111111"), keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) }],
    }).compileToV0Message());
    // A vault signer signs the serialized tx; the fake signs the message with the owner's key.
    const good = { getPublicKeyBase58: () => owner.publicKey.toBase58(), signMessage: owsSign as never, signTransaction: owsSign as never, partialSignTransaction: owsSign as never,
      signTransactionBytes: (bytes: Uint8Array) => nacl.sign.detached(VersionedTransaction.deserialize(bytes).message.serialize(), owner.secretKey) };
    const tx = build();
    await signers.signVersionedSolanaTx(good, tx);
    expect(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], owner.publicKey.toBytes())).toBe(true);

    const bad = { ...good, signTransactionBytes: () => new Uint8Array(64).fill(3) };
    const tx2 = build();
    expect(codeOf(await signers.signVersionedSolanaTx(bad, tx2).catch(e => e))).toBe("SIGNATURE_FAILED");
    expect(tx2.signatures[0].every(b => b === 0)).toBe(true);

    const tx3 = build();
    await signers.signVersionedSolanaTx(new LocalSolanaSigner(owner), tx3);
    expect(nacl.sign.detached.verify(tx3.message.serialize(), tx3.signatures[0], owner.publicKey.toBytes())).toBe(true);
  });
});

// ── 3. Error codes ──

describe("bridge command errors are typed PerpErrors", () => {
  it("gas preflight short → INSUFFICIENT_BALANCE thrown (no hand-built JSON), no signer loaded, nothing executed", async () => {
    checkBridgeGasBalance.mockResolvedValueOnce({ ok: false, errors: ["Source arbitrum: 0.000000 ETH (need ≥0.0001 ETH)"] });
    const getWallet = fakeOws.getWallet.mock.calls.length;
    const err = await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "solana", "--amount", "5"]);
    expect(codeOf(err)).toBe("INSUFFICIENT_BALANCE");
    expect((err as InstanceType<typeof PerpError>).structured.details).toMatchObject({ gas: ["Source arbitrum: 0.000000 ETH (need ≥0.0001 ETH)"] });
    expect(typeof (err as InstanceType<typeof PerpError>).structured.remediation).toBe("string");
    expect(executeBestBridge).not.toHaveBeenCalled();
    // only the address lookups (own-address rule) touched the vault — no signer creation after the gas check
    expect(fakeOws.getWallet.mock.calls.length - getWallet).toBe(4);
    expect(out.some(l => l.includes('"ok":false'))).toBe(false);
  });

  it("gas preflight short on funds bridge exchange → INSUFFICIENT_BALANCE", async () => {
    checkBridgeGasBalance.mockResolvedValueOnce({ ok: false, errors: ["Destination solana: 0.000000 SOL (need ≥0.01 SOL)"] });
    getAllQuotes.mockImplementationOnce(async (s: string, d: string) => [QUOTE(s, d, "cctp", false)]);
    const err = await run(["funds", "bridge", "exchange", "--from", "lighter", "--to", "pacifica", "--amount", "5"]);
    expect(codeOf(err)).toBe("INSUFFICIENT_BALANCE");
    expect((err as InstanceType<typeof PerpError>).structured.remediation).toContain("--fast");
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it.each([
    [["funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5", "--provider", "wormhole"], "INVALID_PARAMS"],
    [["funds", "bridge", "exchange", "--from", "binance", "--to", "pacifica", "--amount", "5"], "INVALID_PARAMS"],
    [["funds", "bridge", "exchange", "--from", "lighter", "--to", "pacifica", "--amount", "5", "--provider", "x"], "INVALID_PARAMS"],
  ])("%j → %s before any quote", async (args, code) => {
    expect(codeOf(await run(args))).toBe(code);
    expect(getAllQuotes).not.toHaveBeenCalled();
  });

  it("no quote → NO_BRIDGE_ROUTE (send, exchange, quote)", async () => {
    getAllQuotes.mockResolvedValue([]);
    expect(codeOf(await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5"]))).toBe("NO_BRIDGE_ROUTE");
    expect(codeOf(await run(["funds", "bridge", "exchange", "--from", "lighter", "--to", "pacifica", "--amount", "5"]))).toBe("NO_BRIDGE_ROUTE");
    expect(codeOf(await run(["funds", "bridge", "quote", "--from", "arbitrum", "--to", "base", "--amount", "5"]))).toBe("NO_BRIDGE_ROUTE");
    getAllQuotes.mockImplementation(async (src: string, dst: string) => [QUOTE(src, dst)]);
  });

  it("forced provider without a quote → NO_BRIDGE_ROUTE with the available ones in the remediation", async () => {
    const err = await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5", "--provider", "debridge"]);
    expect(codeOf(err)).toBe("NO_BRIDGE_ROUTE");
    expect((err as InstanceType<typeof PerpError>).structured.remediation).toContain("cctp");
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it("an ORDER_PENDING from the engine propagates and is logged 'unverified' with the tx hash (never 'failed')", async () => {
    executeBestBridge.mockRejectedValueOnce(new PerpError("ORDER_PENDING", "sent, outcome unknown", { txHash: "0xfeed", remediation: "Do NOT resend" }));
    expect(codeOf(await run(["funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5"]))).toBe("ORDER_PENDING");
    expect(executeBestBridge).toHaveBeenCalledTimes(1);
    expect(logExecution).toHaveBeenCalledWith(expect.objectContaining({ status: "unverified", meta: expect.objectContaining({ txHash: "0xfeed" }) }));
  });

  it("funds bridge exchange --help says it is a wallet-to-wallet bridge with a separate deposit step", async () => {
    const help: string[] = [];
    const prog = program();
    prog.configureOutput({ writeOut: (s) => help.push(s), writeErr: (s) => help.push(s) });
    for (const c of prog.commands) c.configureOutput({ writeOut: (s) => help.push(s), writeErr: (s) => help.push(s) });
    const funds = prog.commands.find(c => c.name() === "funds")!;
    const exchange = funds.commands.find(c => c.name() === "bridge")!.commands.find(c => c.name() === "exchange")!;
    exchange.configureOutput({ writeOut: (s) => help.push(s), writeErr: (s) => help.push(s) });
    exchange.exitOverride();
    await exchange.parseAsync(["--help"], { from: "user" }).catch(() => {});
    const text = help.join("");
    expect(exchange.description()).toContain("wallet → wallet");
    expect(exchange.description()).not.toMatch(/^Bridge USDC between exchanges/);
    expect(text).toContain("NOT the exchange account");
    expect(text).toContain("perp funds deposit");
  });
});
