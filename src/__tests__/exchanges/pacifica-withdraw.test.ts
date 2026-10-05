/**
 * Regression guard: Pacifica withdraw goes only to the account owner's own wallet.
 *
 * The REST API has no destination field, yet the adapter sent a non-existent
 * dest_address and the CLI advertised `--to <address>` — a false affordance that
 * silently routed funds to the own wallet regardless. The fix drops dest_address
 * and refuses a mismatched destination (Rule #2: no misdirection).
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

function build(availableToWithdraw = "1000") {
  const pac = new PacificaAdapter(Keypair.generate(), "mainnet");
  const withdraw = vi.fn().mockResolvedValue({ ok: true });
  const getAccount = vi.fn().mockResolvedValue({ available_to_withdraw: availableToWithdraw });
  (pac as unknown as { client: { withdraw: typeof withdraw; getAccount: typeof getAccount; setRequestAgentWallet: () => void } }).client = {
    withdraw,
    getAccount,
    setRequestAgentWallet: vi.fn(),
  };
  return { pac, withdraw, getAccount, account: pac.publicKey };
}

describe("PacificaAdapter.withdraw — own-wallet only (no destination field)", () => {
  it("withdraws to own wallet and sends NO dest_address", async () => {
    const { pac, withdraw, account } = build();
    await pac.withdraw("100", account);
    const params = withdraw.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual({ amount: "100" });
    expect(params.dest_address).toBeUndefined();
  });

  it("accepts an empty destination (defaults to own wallet)", async () => {
    const { pac, withdraw } = build();
    await pac.withdraw("50", "");
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("throws on a different destination rather than silently sending to own wallet", async () => {
    const { pac, withdraw } = build();
    await expect(pac.withdraw("100", "SomeOtherSolanaAddress")).rejects.toThrow(
      /only go to the account owner's own wallet/,
    );
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe("PacificaAdapter.withdraw — capped by available_to_withdraw", () => {
  it("refuses an amount above available_to_withdraw before signing", async () => {
    const { pac, withdraw, account } = build("99.5");
    await expect(pac.withdraw("100", account)).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("allows exactly available_to_withdraw", async () => {
    const { pac, withdraw, account } = build("100.000000");
    await pac.withdraw("100", account);
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
});

describe("PacificaAdapter.getBalance — unified-margin loan fields", () => {
  it("surfaces a negative USDC balance as borrowedUsdc and pending_interest", async () => {
    const pac = new PacificaAdapter(Keypair.generate(), "mainnet");
    Object.assign(pac as unknown as Record<string, unknown>, {
      client: {
        getAccount: vi.fn().mockResolvedValue({
          balance: "-25.5", account_equity: "100", available_to_spend: "60", available_to_withdraw: "40",
          pending_interest: "0.12", total_margin_used: "10",
        }),
        setRequestAgentWallet: vi.fn(),
      },
      _getPositions: vi.fn().mockResolvedValue([]),
      _getPrices: vi.fn().mockResolvedValue([]),
    });
    const b = await pac.getBalance();
    expect(b).toMatchObject({ usdcBalance: "-25.5", borrowedUsdc: "25.5", pendingInterest: "0.12", availableToWithdraw: "40" });
  });
});
