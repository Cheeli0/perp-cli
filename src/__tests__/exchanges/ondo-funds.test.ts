/**
 * Ondo Perps funding (USDC transfer to the account's funding address, optional probe) and the
 * withdrawal address book (SIWE challenge). Chain RPC (ethers JsonRpcProvider) and the venue
 * client are mocked — nothing is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Interface, SigningKey, Transaction, Wallet, parseUnits } from "ethers";
import { PerpError } from "../../errors.js";

const KEY = `0x${"42".repeat(32)}`;
const WALLET = new Wallet(KEY);
const DEPOSITOR = WALLET.address;
/** ERC-4361 address-book challenge as the venue issues it (domain = the venue, account = the signing wallet). */
const SIWE_CHALLENGE = `app.ondoperps.xyz wants you to sign in with your Ethereum account:\n${DEPOSITOR}\n\nAdd withdrawal address ${DEPOSITOR}\n\nURI: https://app.ondoperps.xyz\nVersion: 1\nChain ID: 1\nNonce: 1`;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ADDR_A = "0x00000000000000000000000000000000000000A1";
const ADDR_B = "0x00000000000000000000000000000000000000b2";
const ACCOUNT = "10458932786832481";

const erc20 = new Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const rpc = { chainId: 42161n, balance: parseUnits("100", 6), gas: 10n ** 18n, broadcasts: [] as Transaction[] };

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeProvider {
    async send(method: string, params?: string[]): Promise<string> {
      if (method === "eth_sendRawTransaction") return (await this.broadcastTransaction(params![0])).hash;
      if (method === "eth_chainId") return `0x${rpc.chainId.toString(16)}`;
      throw new Error(`unexpected rpc ${method}`);
    }
    async call(tx: { data: string }): Promise<string> {
      const sel = tx.data.slice(0, 10);
      if (sel === erc20.getFunction("decimals")!.selector) return erc20.encodeFunctionResult("decimals", [6]);
      if (sel === erc20.getFunction("balanceOf")!.selector) return erc20.encodeFunctionResult("balanceOf", [rpc.balance]);
      throw new Error(`unexpected call ${sel}`);
    }
    async estimateGas(): Promise<bigint> { return 60_000n; }
    async getFeeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; }
    async getBalance(): Promise<bigint> { return rpc.gas; }
    async getTransactionCount(): Promise<number> { return rpc.broadcasts.length; }
    async broadcastTransaction(raw: string): Promise<{ hash: string }> {
      const tx = actual.Transaction.from(raw);
      rpc.broadcasts.push(tx);
      return { hash: tx.hash as string };
    }
    async waitForTransaction(hash: string): Promise<{ status: number; hash: string; logs: never[] }> { return { status: 1, hash, logs: [] }; }
  }
  return { ...actual, JsonRpcProvider: FakeProvider };
});

const f = await import("../../exchanges/ondo/funds.js");
const { ONDO_DEPOSIT_CHAINS } = await import("../../exchanges/venues/ondo.js");

const row = (network: string, address: string, id = ACCOUNT, wallet = "margin", coin = "USDC") => ({ coin, network, address, depositDestination: { id, wallet } });

/** Venue client stub: records every call; `rows` is the live deposit-address list. */
function client(o: { rows?: unknown[]; accountID?: string; provisionAccount?: string; book?: string[]; challenge?: unknown; onPost?: (path: string) => void } = {}) {
  const state = { rows: [...(o.rows ?? [])], book: [...(o.book ?? [])] };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const c = {
    get: vi.fn(async (path: string) => {
      calls.push({ method: "GET", path, body: null });
      if (path === "/v1/account") return { accountID: o.accountID ?? ACCOUNT };
      if (path === "/v1/wallet/address_book") return { addressBook: state.book.map(a => ({ withdrawalAddress: a, label: "", lastUpdated: "" })) };
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      o.onPost?.(path);
      if (path === "/v1/wallet/deposit_address/list") return state.rows;
      if (path === "/v1/provision_address") {
        const b = body as { network: string };
        state.rows.push(row(b.network, ADDR_B));
        return { chain: b.network, accountId: o.provisionAccount ?? ACCOUNT, symbol: "USDC", address: ADDR_B };
      }
      if (path === "/v1/auth/erc-4361/address_book/get_challenge") return o.challenge ?? { id: "chg_1", message: SIWE_CHALLENGE };
      throw new Error(`unexpected POST ${path}`);
    }),
    postNoResult: vi.fn(async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      o.onPost?.(path);
      if (path === "/v1/auth/erc-4361/address_book/complete_challenge") { state.book.push(DEPOSITOR); return; }
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  return { c: c as unknown as import("../../exchanges/ondo/funds.js").OndoFundsClient, calls, state, paths: () => calls.map(x => x.path) };
}

const sign = async (tx: Transaction): Promise<string> => new SigningKey(KEY).sign(tx.unsignedHash).serialized;
const timing = (timeoutMs = 30_000) => { let t = 0; return { timeoutMs, pollMs: 10_000, sleep: async (ms: number) => { t += ms; }, now: () => t }; };
const funding = { accountId: ACCOUNT, address: ADDR_A, provisioned: false };
const plan = (o: Partial<{ amount: string; probe: string | null; network: "mainnet" | "testnet" }> = {}) =>
  f.planOndoDeposit({ network: o.network ?? "mainnet", chain: "arbitrum", amount: o.amount ?? "15", probe: o.probe === undefined ? null : o.probe, depositor: DEPOSITOR, funding });

beforeEach(() => { rpc.chainId = 42161n; rpc.balance = parseUnits("100", 6); rpc.gas = 10n ** 18n; rpc.broadcasts = []; });

describe("pins", () => {
  it("USDC on Arbitrum / Ethereum with chain ids and RPCs", () => {
    expect(ONDO_DEPOSIT_CHAINS.arbitrum).toMatchObject({ chainId: 42161, usdc: ARB_USDC, rpcUrl: "https://arb1.arbitrum.io/rpc" });
    expect(ONDO_DEPOSIT_CHAINS.ethereum).toMatchObject({ chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
    expect(() => f.ondoDepositChain("avalanche")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});

describe("funding address selection", () => {
  it("picks the FIRST listed USDC address of the chosen network for the margin wallet", () => {
    const rows = [row("ethereum", ADDR_B), row("arbitrum", ADDR_A), row("arbitrum", ADDR_B), row("avalanche", ADDR_B)];
    expect(f.selectOndoDepositAddress(rows, "arbitrum", ACCOUNT)).toBe(ADDR_A);
    expect(f.selectOndoDepositAddress(rows, "ethereum", ACCOUNT)).toBe(ADDR_B);
  });

  it("skips other coins / the main wallet; none for the network → null", () => {
    expect(f.selectOndoDepositAddress([row("arbitrum", ADDR_B, ACCOUNT, "margin", "SPYon"), row("arbitrum", ADDR_B, ACCOUNT, "main"), row("arbitrum", ADDR_A)], "arbitrum", ACCOUNT)).toBe(ADDR_A);
    expect(f.selectOndoDepositAddress([row("ethereum", ADDR_A)], "arbitrum", ACCOUNT)).toBeNull();
  });

  it("depositDestination.id that is not this account → refused", () => {
    expect(() => f.selectOndoDepositAddress([row("arbitrum", ADDR_A, "999")], "arbitrum", ACCOUNT)).toThrow(/belongs to account 999/);
  });

  it("a non-list response / a malformed address → EXCHANGE_ERROR", () => {
    expect(() => f.selectOndoDepositAddress({ rows: [] }, "arbitrum", ACCOUNT)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    expect(() => f.selectOndoDepositAddress([row("arbitrum", "not-an-address")], "arbitrum", ACCOUNT)).toThrow(/not an EVM address/);
  });

  it("NEVER provisions when the list already has an address for that network", async () => {
    const v = client({ rows: [row("arbitrum", ADDR_A), row("arbitrum", ADDR_B)] });
    await expect(f.resolveOndoDepositAddress(v.c, "arbitrum")).resolves.toEqual({ accountId: ACCOUNT, address: ADDR_A, provisioned: false });
    expect(v.paths()).toEqual(["/v1/account", "/v1/wallet/deposit_address/list"]);
    expect(v.calls[1].body).toEqual({ coins: ["USDC"] });
  });

  it("provisions exactly once when the network has no address, then uses the listed one", async () => {
    const v = client({ rows: [row("ethereum", ADDR_A)] });
    await expect(f.resolveOndoDepositAddress(v.c, "arbitrum")).resolves.toEqual({ accountId: ACCOUNT, address: ADDR_B, provisioned: true });
    expect(v.paths()).toEqual(["/v1/account", "/v1/wallet/deposit_address/list", "/v1/provision_address", "/v1/wallet/deposit_address/list"]);
    expect(v.calls[2].body).toEqual({ network: "arbitrum", symbol: "USDC", deposit_destination: { id: ACCOUNT, wallet: "margin" } });
  });

  it("an address of another account is refused WITHOUT provisioning; a provision answer for another account is refused", async () => {
    const other = client({ rows: [row("arbitrum", ADDR_A, "999")] });
    await expect(f.resolveOndoDepositAddress(other.c, "arbitrum")).rejects.toThrow(/belongs to account 999/);
    expect(other.paths()).not.toContain("/v1/provision_address");
    await expect(f.resolveOndoDepositAddress(client({ provisionAccount: "999" }).c, "arbitrum")).rejects.toThrow(/provision_address answered for account 999/);
  });
});

describe("planOndoDeposit", () => {
  it("reads decimals on-chain and plans a single transfer or probe + remainder", async () => {
    expect(await plan()).toMatchObject({ chainId: 42161, token: ARB_USDC, decimals: 6, amountRaw: 15_000_000n, probeRaw: null, depositAddress: ADDR_A });
    expect(await plan({ probe: "2" })).toMatchObject({ amountRaw: 15_000_000n, probeRaw: 2_000_000n });
  });

  it("testnet → CAPABILITY_UNSUPPORTED; probe ≥ amount, short balance, no gas, wrong RPC chain → refused", async () => {
    await expect(plan({ network: "testnet" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    await expect(plan({ probe: "15" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    rpc.balance = 14_999_999n;
    await expect(plan()).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    rpc.balance = parseUnits("100", 6); rpc.gas = 0n;
    await expect(plan()).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    rpc.gas = 1n; rpc.chainId = 1n;
    await expect(plan()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("executeOndoDeposit", () => {
  const deposits = (confirmed: () => boolean) => vi.fn(async () => rpc.broadcasts.map(t => ({ coin: "USDC", txid: t.hash, status: confirmed() ? "confirmed" : "pending" })));

  it("single transfer: USDC.transfer(fundingAddress, amount) from the master, then waits for the credit", async () => {
    const res = await f.executeOndoDeposit(await plan(), sign, deposits(() => true), timing());
    expect(rpc.broadcasts).toHaveLength(1);
    const tx = rpc.broadcasts[0];
    expect(tx).toMatchObject({ to: ARB_USDC, from: DEPOSITOR, chainId: 42161n, value: 0n });
    expect(erc20.parseTransaction({ data: tx.data })!.args.toArray()).toEqual([ADDR_A, 15_000_000n]);
    expect(res).toEqual({ depositAddress: ADDR_A, transfers: [{ step: "deposit", txHash: tx.hash, amount: "15.0" }] });
  });

  it("probe flow: probe → credited → remainder (amount − probe)", async () => {
    const res = await f.executeOndoDeposit(await plan({ probe: "2" }), sign, deposits(() => true), timing());
    expect(rpc.broadcasts.map(t => erc20.parseTransaction({ data: t.data })!.args[1])).toEqual([2_000_000n, 13_000_000n]);
    expect(res.transfers.map(t => t.step)).toEqual(["probe", "deposit"]);
  });

  it("probe NOT credited within the window → ORDER_PENDING with the probe tx hash; the remainder is NOT sent", async () => {
    const err = await f.executeOndoDeposit(await plan({ probe: "2" }), sign, deposits(() => false), timing()).catch(e => e);
    expect(err).toBeInstanceOf(PerpError);
    expect(err.structured).toMatchObject({ code: "ORDER_PENDING", details: { txHash: rpc.broadcasts[0].hash, depositAddress: ADDR_A, sent: [{ step: "probe", amount: "2.0" }] } });
    expect(err.message).toContain("13.0 USDC was NOT sent");
    expect(rpc.broadcasts).toHaveLength(1);
  });

  it("deposit history unreadable → still ORDER_PENDING for the probe, nothing more sent", async () => {
    const read = vi.fn(async () => { throw new Error("HTTP 503"); });
    await expect(f.executeOndoDeposit(await plan({ probe: "2" }), sign, read, timing())).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(rpc.broadcasts).toHaveLength(1);
  });
});

describe("address book", () => {
  const REST = "https://api.ondoperps.xyz";
  const add = (v: ReturnType<typeof client>, signMessage = (m: string) => WALLET.signMessage(m)) =>
    f.addOndoAddressBookEntry(v.c, { wallet: DEPOSITOR, restUrl: REST, label: "perp-cli", signMessage });

  it("lists withdrawal addresses; a destination that is not listed gets the SIWE / CLI remediation", async () => {
    await expect(f.ondoAddressBook(client({ book: [ADDR_A] }).c)).resolves.toEqual([ADDR_A]);
    const err = f.ondoAddressNotOnBook(ADDR_B, [ADDR_A]);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.remediation).toContain(`perp funds address-book add ondo ${ADDR_B}`);
    expect(err.structured.remediation).toContain("SIWE");
  });

  it("get_challenge → personal_sign by the wallet → complete_challenge → listed", async () => {
    const v = client();
    const res = await add(v);
    expect(res).toEqual({ address: DEPOSITOR, alreadyListed: false, listed: true, challengeId: "chg_1" });
    expect(v.paths()).toEqual(["/v1/wallet/address_book", "/v1/auth/erc-4361/address_book/get_challenge", "/v1/auth/erc-4361/address_book/complete_challenge", "/v1/wallet/address_book"]);
    expect(v.calls[1].body).toEqual({ walletAddress: DEPOSITOR, chainId: "1", withdrawalAddress: DEPOSITOR });
    const done = v.calls[2].body as { id: string; signature: string; addressLabel: string };
    expect(done).toMatchObject({ id: "chg_1", addressLabel: "perp-cli" });
    const { verifyMessage } = await import("ethers");
    expect(verifyMessage(SIWE_CHALLENGE, done.signature)).toBe(DEPOSITOR);
  });

  it("already listed → no challenge, nothing signed", async () => {
    const v = client({ book: [DEPOSITOR.toLowerCase()] });
    const signMessage = vi.fn();
    await expect(add(v, signMessage)).resolves.toMatchObject({ alreadyListed: true, listed: true });
    expect(signMessage).not.toHaveBeenCalled();
    expect(v.paths()).toEqual(["/v1/wallet/address_book"]);
  });

  it("a challenge that does not name the address, or a SIWE message for another domain / account → POLICY_DENIED, nothing signed", async () => {
    const signMessage = vi.fn();
    for (const message of [
      "Sign in to example.com",
      // Names the address but is not SIWE-shaped: free-form text is never signed.
      `Sign this message to add withdrawal address ${DEPOSITOR} to your address book.`,
      `evil.example wants you to sign in with your Ethereum account:\n${DEPOSITOR}\n\nAdd ${DEPOSITOR}\n\nURI: https://evil.example\nVersion: 1\nChain ID: 1\nNonce: 1`,
      `app.ondoperps.xyz wants you to sign in with your Ethereum account:\n${ADDR_A}\n\nAdd ${DEPOSITOR}\n\nURI: https://app.ondoperps.xyz\nVersion: 1\nChain ID: 1\nNonce: 1`,
    ]) {
      await expect(add(client({ challenge: { id: "c", message } }), signMessage)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    }
    expect(signMessage).not.toHaveBeenCalled();
    const ok = `app.ondoperps.xyz wants you to sign in with your Ethereum account:\n${DEPOSITOR}\n\nAdd withdrawal address ${DEPOSITOR}\n\nURI: https://app.ondoperps.xyz\nVersion: 1\nChain ID: 1\nNonce: 1`;
    await expect(add(client({ challenge: { id: "c", message: ok } }))).resolves.toMatchObject({ listed: true });
  });

  it("a signature that does not recover to the wallet → SIGNATURE_FAILED, nothing submitted", async () => {
    const v = client();
    await expect(add(v, m => new Wallet(`0x${"43".repeat(32)}`).signMessage(m))).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(v.paths()).not.toContain("/v1/auth/erc-4361/address_book/complete_challenge");
  });

  it("the venue refusing API-key auth for the challenge is surfaced with its error code and the web-app route", async () => {
    const v = client({ onPost: (path) => {
      if (path.includes("get_challenge")) throw new PerpError("NO_SIGNER_AVAILABLE", "Ondo Perps: authentication required (auth_missing) [POST /v1/auth/erc-4361/address_book/get_challenge, HTTP 401]", { venueCode: "auth_missing", httpStatus: 401 });
    } });
    const err = await add(v).catch(e => e);
    expect(err.structured).toMatchObject({ code: "NO_SIGNER_AVAILABLE", details: { venueCode: "auth_missing", httpStatus: 401 } });
    expect(err.message).toContain("auth_missing");
    expect(err.structured.remediation).toContain("Ondo Perps web app");
  });
});
