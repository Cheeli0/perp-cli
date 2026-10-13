/**
 * SSOT Rule #3: key material is never accepted on argv nor written to ~/.perp/.env.
 *
 *  - `wallet import <key>` / `--evm <hex>` / `--solana <key>` are refused (shell history,
 *    process list) — the key comes from stdin or the hidden prompt, like `wallet set`;
 *  - `wallet generate --legacy` / `wallet import --legacy` (raw keys → ~/.perp/.env +
 *    wallets.json) are refused with remediation pointing at the OWS vault;
 *  - `settings env set <exchange|*_PRIVATE_KEY|secret> <value>` is refused;
 *  - `wallet list --json` never prints a legacy wallets.json private key;
 *  - a legacy ~/.perp/.env is still READ (settings env show derives the address).
 *
 * OWS is mocked; HOME is isolated (helpers/isolate-home.ts); fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const acct = [{ chainId: "eip155:1", address: "0xabc" }, { chainId: "solana:mainnet", address: "Sol1" }];
const mockOws = {
  importWalletPrivateKey: vi.fn((name: string) => ({ id: "w1", name, accounts: acct })),
  importWalletMnemonic: vi.fn((name: string) => ({ id: "w2", name, accounts: acct })),
  createWallet: vi.fn(),
  listWallets: vi.fn(() => []),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));

const { registerWalletCommands } = await import("../../commands/wallet.js");
const { registerSettingsCommands } = await import("../../commands/settings.js");

const PK_HEX = "42".repeat(32);
const PK = `0x${PK_HEX}`;
const SOL_HEX = "17".repeat(32);
const PERP_DIR = resolve(process.env.HOME as string, ".perp");
const ENV_FILE = resolve(PERP_DIR, ".env");
const WALLETS_FILE = resolve(PERP_DIR, "wallets.json");

function program(): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p);
  p.option("--passphrase <pp>");
  registerWalletCommands(p, () => true);
  registerSettingsCommands(p, () => true);
  return p;
}

let out: string[];
const realStdin = process.stdin;
function pipeStdin(text: string): void {
  const s = Readable.from([text]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(s, "isTTY", { value: false });
  Object.defineProperty(process, "stdin", { value: s, configurable: true });
}
const lastJson = () => JSON.parse(out.filter(l => l.includes('"ok"')).at(-1)!);
const envFileText = () => (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "");

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  delete process.env.OWS_PASSPHRASE;
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
});
afterEach(() => {
  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  delete process.env.OWS_PASSPHRASE;
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet import: never a key on argv", () => {
  it.each([
    [["wallet", "import", PK]],
    [["wallet", "import", "--evm", PK]],
    [["wallet", "import", "--solana", PK]],
    [["wallet", "import", "--evm", PK, "--solana", SOL_HEX]],
    [["wallet", "import", "--mnemonic", "abandon abandon abandon"]],
  ])("%j → INVALID_PARAMS, nothing imported, key not echoed", async (argv) => {
    process.env.OWS_PASSPHRASE = "pp";
    await program().parseAsync(["node", "perp", ...argv]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(lastJson().error.remediation).toMatch(/stdin|prompt/);
    expect(mockOws.importWalletPrivateKey).not.toHaveBeenCalled();
    expect(mockOws.importWalletMnemonic).not.toHaveBeenCalled();
    expect(out.join("\n")).not.toContain(PK_HEX);
    expect(process.exitCode).toBe(1);
  });

  it("piped EVM key + OWS_PASSPHRASE → vault import", async () => {
    process.env.OWS_PASSPHRASE = "pp";
    pipeStdin(`${PK}\n`);
    await program().parseAsync(["node", "perp", "wallet", "import", "--name", "main"]);
    expect(mockOws.importWalletPrivateKey).toHaveBeenCalledWith("main", PK, "pp", undefined, "evm");
    expect(lastJson()).toMatchObject({ ok: true, data: { name: "main" } });
    expect(out.join("\n")).not.toContain(PK_HEX);
    expect(envFileText()).not.toContain(PK_HEX);
  });

  it("--chain dual reads two stdin lines (EVM first, then Solana)", async () => {
    process.env.OWS_PASSPHRASE = "";
    pipeStdin(`${PK}\n${SOL_HEX}\n`);
    await program().parseAsync(["node", "perp", "wallet", "import", "--name", "both", "--chain", "dual"]);
    expect(mockOws.importWalletPrivateKey).toHaveBeenCalledTimes(1);
    const c = mockOws.importWalletPrivateKey.mock.calls[0] as unknown[];
    expect(c[0]).toBe("both");
    expect(c[2]).toBe("");
    expect(c[5]).toBe(PK);
  });

  it("--chain dual with a single line → INVALID_PARAMS, nothing imported", async () => {
    process.env.OWS_PASSPHRASE = "";
    pipeStdin(`${PK}\n`);
    await program().parseAsync(["node", "perp", "wallet", "import", "--chain", "dual"]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(mockOws.importWalletPrivateKey).not.toHaveBeenCalled();
  });

  it("--mnemonic reads the phrase from stdin", async () => {
    process.env.OWS_PASSPHRASE = "pp";
    pipeStdin("word1 word2 word3\n");
    await program().parseAsync(["node", "perp", "wallet", "import", "--mnemonic", "--name", "m"]);
    expect(mockOws.importWalletMnemonic).toHaveBeenCalledWith("m", "word1 word2 word3", "pp");
  });

  it("piped key with no passphrase source → PASSPHRASE_REQUIRED, nothing imported", async () => {
    pipeStdin(PK);
    await program().parseAsync(["node", "perp", "wallet", "import"]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "PASSPHRASE_REQUIRED" } });
    expect(mockOws.importWalletPrivateKey).not.toHaveBeenCalled();
  });
});

describe("--legacy raw-key write paths are removed", () => {
  it.each([
    [["wallet", "generate", "--legacy", "evm"]],
    [["wallet", "generate", "x", "--legacy", "solana"]],
    [["wallet", "import", "--legacy", "evm"]],
    [["wallet", "import", PK, "--legacy", "evm"]],
  ])("%j → INVALID_PARAMS pointing at OWS; no .env / wallets.json write", async (argv) => {
    await program().parseAsync(["node", "perp", ...argv]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(lastJson().error.remediation).toMatch(/OWS|wallet set|wallet import/);
    expect(envFileText()).toBe("");
    expect(existsSync(WALLETS_FILE)).toBe(false);
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(out.join("\n")).not.toContain(PK_HEX);
  });
});

describe("settings env set refuses key material", () => {
  it.each([
    ["hyperliquid", PK],
    ["hl", PK],
    ["HL_PRIVATE_KEY", PK],
    ["PRIVATE_KEY", PK],
    ["OWS_PASSPHRASE", "pp"],
    ["MY_EXCHANGE_SECRET", "s"],
  ])("settings env set %s → INVALID_PARAMS, ~/.perp/.env untouched", async (name, value) => {
    await program().parseAsync(["node", "perp", "settings", "env", "set", name, value]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(envFileText()).toBe("");
    expect(out.join("\n")).not.toContain(PK_HEX);
  });

  it("a non-secret value is still written", async () => {
    await program().parseAsync(["node", "perp", "settings", "env", "set", "LIGHTER_REFERRAL_CODE", "REF1"]);
    expect(lastJson()).toMatchObject({ ok: true, data: { key: "LIGHTER_REFERRAL_CODE" } });
    expect(envFileText()).toContain("LIGHTER_REFERRAL_CODE=REF1");
    delete process.env.LIGHTER_REFERRAL_CODE;
  });
});

describe("legacy key stores are still read, never printed", () => {
  it("settings env show still derives the address from a legacy ~/.perp/.env key", async () => {
    mkdirSync(PERP_DIR, { recursive: true });
    writeFileSync(ENV_FILE, `HL_PRIVATE_KEY=${PK}\n`);
    await program().parseAsync(["node", "perp", "settings", "env", "show"]);
    const json = lastJson();
    expect(json.ok).toBe(true);
    expect(json.data.exchanges.find((e: { exchange: string }) => e.exchange === "hyperliquid").address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(out.join("\n")).not.toContain(PK_HEX);
  });

  it("wallet list --json omits legacy wallets.json private keys", async () => {
    mkdirSync(PERP_DIR, { recursive: true });
    writeFileSync(WALLETS_FILE, JSON.stringify({
      wallets: { old: { name: "old", type: "evm", address: "0x1111111111111111111111111111111111111111", privateKey: PK, createdAt: "2026-01-01" } },
      active: { hyperliquid: "old" },
    }));
    await program().parseAsync(["node", "perp", "wallet", "list"]);
    const json = lastJson();
    expect(json.data.legacy.wallets.old).toEqual({ name: "old", type: "evm", address: "0x1111111111111111111111111111111111111111", createdAt: "2026-01-01" });
    expect(out.join("\n")).not.toContain(PK_HEX);
  });
});
