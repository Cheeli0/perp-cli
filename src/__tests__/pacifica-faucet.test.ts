/**
 * `perp -n testnet funds faucet pacifica <amount>` — devnet mint_test_usdc (testnet tooling).
 * Instruction layout, mainnet refusal, --dry-run plan, simulate-before-send. No network.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import { addRootSafetyOptions } from "../cli-flags.js";
import { registerFundsCommands } from "../commands/funds.js";
import {
  buildMintTestUsdcInstruction, mintTestUsdc, mintTestUsdcDiscriminator, mintTestUsdcPlan, testUsdcBaseUnits,
} from "../pacifica/faucet.js";
import { TESTNET_CENTRAL_STATE, TESTNET_PROGRAM_ID, TESTNET_USDC_MINT } from "../pacifica/constants.js";
import { LocalSolanaSigner } from "../signer/solana-local.js";
import type { Network } from "../pacifica/index.js";

describe("mint_test_usdc instruction", () => {
  it("discriminator = sha256('global:mint_test_usdc')[:8]", () => {
    expect(mintTestUsdcDiscriminator().toString("hex")).toBe("76904e769bd6b9ba");
  });

  it("encodes amount × 1e6 as u64 LE and the documented account list", () => {
    const user = Keypair.generate().publicKey;
    const plan = mintTestUsdcPlan(user, "1000.5");
    const ix = buildMintTestUsdcInstruction(plan);
    expect(ix.programId.toBase58()).toBe(TESTNET_PROGRAM_ID);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe("76904e769bd6b9ba");
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_500_000n);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("user_account"), user.toBuffer()], new PublicKey(TESTNET_PROGRAM_ID));
    expect(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [user.toBase58(), true, true],
      [pda.toBase58(), false, true],
      [plan.userAta, false, true],
      [TESTNET_USDC_MINT, false, true],
      [TESTNET_CENTRAL_STATE, false, false],
      ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
      ["11111111111111111111111111111111", false, false],
    ]);
  });

  it.each(["0", "-1", "1.0000001", "1e3", "abc"])("rejects amount %s", (a) => {
    expect(() => testUsdcBaseUnits(a)).toThrow();
  });
});

describe("mintTestUsdc — simulate before send", () => {
  function conn(simErr: unknown) {
    return {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 })),
      simulateTransaction: vi.fn(async () => ({ value: { err: simErr, logs: ["Program log: x"] } })),
      sendRawTransaction: vi.fn(async () => "sig123"),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    };
  }

  it("a failed simulation sends nothing", async () => {
    const c = conn({ InstructionError: [1, "Custom"] });
    await expect(mintTestUsdc(c as never, new LocalSolanaSigner(Keypair.generate()), "10"))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a clean simulation is sent, with a 400k compute limit first", async () => {
    const c = conn(null);
    const r = await mintTestUsdc(c as never, new LocalSolanaSigner(Keypair.generate()), "10");
    expect(r.signature).toBe("sig123");
    const tx = c.simulateTransaction.mock.calls[0][0] as { instructions: Array<{ programId: PublicKey; data: Buffer }> };
    expect(tx.instructions[0].programId.toBase58()).toBe("ComputeBudget111111111111111111111111111111");
    expect(tx.instructions[0].data.readUInt32LE(1)).toBe(400_000);
    expect(tx.instructions[1].programId.toBase58()).toBe(TESTNET_PROGRAM_ID);
  });
});

describe("funds faucet pacifica command", () => {
  function program(network: Network) {
    const prog = new Command();
    prog.exitOverride();
    addRootSafetyOptions(prog);
    const getAdapter = vi.fn(async () => { throw new Error("adapter must not be built"); });
    registerFundsCommands(prog, getAdapter, () => true, () => network, getAdapter);
    return { prog, getAdapter };
  }

  it("refuses mainnet with CAPABILITY_UNSUPPORTED before anything is built", async () => {
    const { prog, getAdapter } = program("mainnet");
    await expect(prog.parseAsync(["node", "perp", "funds", "faucet", "pacifica", "100"]))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("--dry-run on testnet prints the plan and sends nothing", async () => {
    const { prog, getAdapter } = program("testnet");
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...m: unknown[]) => { out.push(m.map(String).join(" ")); });
    try {
      await prog.parseAsync(["node", "perp", "-n", "testnet", "--dry-run", "funds", "faucet", "pacifica", "100"]);
    } finally {
      spy.mockRestore();
    }
    const json = JSON.parse(out.join(""));
    expect(json).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "pacifica", network: "testnet", baseUnits: "100000000", programId: TESTNET_PROGRAM_ID } });
    expect(getAdapter).not.toHaveBeenCalled();
  });
});
