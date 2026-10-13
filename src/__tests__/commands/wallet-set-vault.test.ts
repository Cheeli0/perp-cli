/**
 * `wallet set <exchange>` imports the key into the OWS vault (SSOT Rule #3) — never
 * ~/.perp/.env, never argv — and makes it the active wallet.
 *
 *  - a key on argv is rejected (shell history / process list) before anything is stored;
 *  - piped stdin key + OWS_PASSPHRASE → importWalletPrivateKey, owsActiveWallet set,
 *    no .env write, key never echoed, no venue call (Lighter: explicit approve next step);
 *  - piped stdin without a passphrase source → PASSPHRASE_REQUIRED, nothing imported.
 *
 * OWS is mocked; HOME is isolated (helpers/isolate-home.ts); fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const mockOws = {
  importWalletPrivateKey: vi.fn((name: string) => ({ id: "w1", name, accounts: [{ chainId: "eip155:1", address: "0xabc" }] })),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));

const { registerWalletCommands } = await import("../../commands/wallet.js");
const { loadSettings } = await import("../../settings.js");

const PK_HEX = "42".repeat(32);
const PK = `0x${PK_HEX}`;
const ENV_FILE = resolve(process.env.HOME as string, ".perp", ".env");

function program(): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p);
  p.option("--passphrase <pp>");
  registerWalletCommands(p, () => true);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet set → OWS vault", () => {
  it("rejects a key on argv with INVALID_PARAMS; nothing stored, key not echoed", async () => {
    await program().parseAsync(["node", "perp", "wallet", "set", "hl", PK]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(lastJson().error.remediation).toMatch(/stdin|prompt/);
    expect(mockOws.importWalletPrivateKey).not.toHaveBeenCalled();
    expect(loadSettings().owsActiveWallet).toBe("");
    expect(out.join("\n")).not.toContain(PK_HEX);
  });

  it("piped key + OWS_PASSPHRASE → vault import, active wallet, no .env write, no venue call", async () => {
    process.env.OWS_PASSPHRASE = "pp";
    pipeStdin(`${PK}\n`);
    await program().parseAsync(["node", "perp", "wallet", "set", "lighter"]);
    expect(mockOws.importWalletPrivateKey).toHaveBeenCalledWith("lighter", PK, "pp", undefined, "evm");
    expect(loadSettings().owsActiveWallet).toBe("lighter");
    expect(existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "").not.toContain(PK_HEX);
    expect(fetch).not.toHaveBeenCalled();
    const json = lastJson();
    expect(json).toMatchObject({ ok: true, data: { exchange: "lighter", owsWallet: "lighter", activeWallet: "lighter" } });
    expect(json.data.lighterApiKey).toEqual({ registered: false, nextStep: "perp wallet agent approve lighter" });
    expect(out.join("\n")).not.toContain(PK_HEX);
  });

  it("--name and root --passphrase are honored", async () => {
    pipeStdin(PK_HEX);
    await program().parseAsync(["node", "perp", "--passphrase", "x", "wallet", "set", "hl", "--name", "main"]);
    expect(mockOws.importWalletPrivateKey).toHaveBeenCalledWith("main", PK, "x", undefined, "evm");
    expect(loadSettings().owsActiveWallet).toBe("main");
  });

  it("piped key with no passphrase source → PASSPHRASE_REQUIRED, nothing imported", async () => {
    pipeStdin(PK);
    await program().parseAsync(["node", "perp", "wallet", "set", "hl"]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "PASSPHRASE_REQUIRED" } });
    expect(mockOws.importWalletPrivateKey).not.toHaveBeenCalled();
    expect(out.join("\n")).not.toContain(PK_HEX);
  });
});
