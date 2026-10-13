/**
 * `funds deposit aster|ondo`, `funds withdraw aster` — fund movements
 * whose on-chain leg is signed by the OWS master wallet (src/evm-master-tx.ts).
 *
 * Every command: `--dry-run` prints the plan and returns before any key, adapter or network is
 * touched; the live path runs all read-only checks before the first signature; an outcome that
 * cannot be read after a send is ORDER_PENDING (logged "unverified"), never "failed".
 */

import { Command } from "commander";
import chalk from "chalk";
import { supportsDryRun } from "../cli-flags.js";
import { cliCredentialOptsFrom } from "../config.js";
import { PerpError, parsePositiveDecimal } from "../errors.js";
import { logExecution } from "../execution-log.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { getVenue, type Network } from "../exchanges/venue.js";
import { ASTER_FUNDS_CHAINS } from "../exchanges/venues/aster.js";
import { ONDO_DEPOSIT_CHAINS } from "../exchanges/venues/ondo.js";
import { jsonOk, printJson } from "../utils.js";

export interface OnchainFundsContext {
  program: Command;
  funds: Command;
  deposit: Command;
  withdraw: Command;
  isJson: () => boolean;
  isDryRun: () => boolean;
  getNetwork: () => Network;
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>;
  requireMaster: (venue: "aster" | "ondo", action: string) => Promise<void>;
  printFundsPlan: (plan: { action: "deposit" | "withdraw" | "transfer"; venue: string; network: string; asset: string; amount: string; [k: string]: unknown }) => void;
  failStatus: (err: unknown) => "failed" | "unverified";
}

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function registerOnchainFundsCommands(ctx: OnchainFundsContext): void {
  const { program, funds, deposit, withdraw, isJson, isDryRun, getNetwork, getAdapterForExchange, printFundsPlan, failStatus } = ctx;
  const creds = () => cliCredentialOptsFrom(program.opts());

  /** Execution-log + rethrow for a failed live fund movement (unknown outcome → "unverified"). */
  const logFailure = (venue: string, asset: string, side: "deposit" | "withdraw", amount: string, err: unknown, meta: Record<string, unknown>): void => {
    const txHash = err instanceof PerpError ? err.structured.details?.txHash : undefined;
    logExecution({
      type: "bridge", exchange: venue, symbol: asset, side, size: amount, status: failStatus(err), dryRun: false,
      error: err instanceof Error ? err.message : String(err),
      meta: { action: side, ...meta, ...(typeof txHash === "string" ? { txHash } : {}) },
    });
  };

  // ═══ Aster deposit — vault contract on BNB Chain / Arbitrum ═══

  supportsDryRun(deposit.command("aster <amount>"))
    .description("Deposit USDT / USDC into Aster perps through the vault contract on BNB Chain or Arbitrum (approve + deposit; mainnet only; supports --dry-run)")
    // --chain, not --network: the root -n/--network (mainnet | testnet) would swallow a subcommand --network.
    .option("--chain <chain>", "Source chain: bsc | arbitrum", "bsc")
    .option("--asset <asset>", "Deposit asset: USDT | USDC", "USDT")
    .action(async (amount: string, opts: { chain: string; asset: string }) => {
      const net = getNetwork();
      const { requireAsterFundsNetwork, asterFundsChain, asterFundsAsset, planAsterDeposit, executeAsterDeposit, awaitAsterDepositCredit, ASTER_DEPOSIT_CREDIT_TIMEOUT_MS, ASTER_DEPOSIT_CREDIT_POLL_MS } = await import("../exchanges/aster-funds.js");
      requireAsterFundsNetwork(net, "deposit");
      const chain = asterFundsChain(opts.chain);
      const asset = asterFundsAsset(opts.asset);
      parsePositiveDecimal(amount, "amount");
      const pins = ASTER_FUNDS_CHAINS[chain];
      if (isDryRun()) {
        return printFundsPlan({
          action: "deposit", venue: "aster", network: net, asset, amount, chain: pins.label, chainId: pins.chainId,
          vault: pins.vault, token: pins.tokens[asset], broker: "1 (perp account)", signer: "OWS master wallet",
          steps: `approve(vault, exact amount) when the allowance is short → vault.depositFor(${asset}, forAddress = the master wallet, amount, broker 1) → Deposit event check → venue credit poll`,
          checks: "eth_chainId, on-chain decimals(), supportToken, paused(), token balance, native gas, allowance, deposit simulation",
        });
      }
      const { loadMasterEvmSigner } = await import("../evm-master-tx.js");
      const signer = await loadMasterEvmSigner("aster", creds(), "Aster deposit");
      const depositor = signer.getAddress();
      // The venue credit is confirmed through the API wallet — required before anything is sent.
      const { AsterAdapter } = await import("../exchanges/aster.js");
      const adapter = await getAdapterForExchange("aster");
      if (!(adapter instanceof AsterAdapter)) throw new Error("aster venue did not produce an AsterAdapter");
      if (adapter.activeSignerTier !== "agent") {
        throw new PerpError("AGENT_NOT_REGISTERED", "Aster deposit confirms the venue credit through an API wallet, and none is usable on this computer", {
          exchange: "aster", remediation: "Approve one first (this works before the first deposit): perp wallet agent approve aster — then retry the deposit",
        });
      }
      if (adapter.userAddress.toLowerCase() !== depositor.toLowerCase()) {
        throw new PerpError("INVALID_PARAMS", `The master wallet ${depositor} is not the owner of the Aster API wallet's account (${adapter.userAddress}) — the vault credits the sender`, {
          exchange: "aster", remediation: "Select the wallet that owns the Aster account (--ows <wallet>)",
        });
      }

      const plan = await planAsterDeposit({ network: net, chain, asset, amount, depositor });
      const view = {
        venue: "aster", network: net, asset, amount, depositor, chain: plan.chainLabel, chainId: plan.chainId,
        vault: plan.vault, token: plan.token, decimals: plan.decimals, broker: plan.broker.toString(), needsApprove: plan.needsApprove,
      };
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing ${amount} ${asset} into Aster perps on ${plan.chainLabel}...\n`));
        console.log(`  From:  ${depositor}`);
        console.log(`  Vault: ${plan.vault}`);
        if (plan.needsApprove) console.log(chalk.gray(`  Approving ${amount} ${asset} for the vault...`));
      }
      try {
        const res = await executeAsterDeposit(plan, tx => signer.signTransaction(tx));
        if (!isJson()) console.log(chalk.gray(`  Deposit tx ${res.depositTxHash} confirmed (Deposit event verified). Waiting for the venue credit...`));
        const credit = await awaitAsterDepositCredit(() => adapter.depositWithdrawHistory(), res.depositTxHash, {
          timeoutMs: ASTER_DEPOSIT_CREDIT_TIMEOUT_MS, pollMs: ASTER_DEPOSIT_CREDIT_POLL_MS, sleep: realSleep, now: () => Date.now(),
        });
        logExecution({
          type: "bridge", exchange: "aster", symbol: asset, side: "deposit", size: amount, status: "success", dryRun: false,
          meta: { action: "deposit", method: "vault", chain, txHash: res.depositTxHash, approveTxHash: res.approveTxHash },
        });
        if (isJson()) return printJson(jsonOk({ ...view, ...res, method: "vault", credit: { state: credit.state, amount: credit.amount, accountType: credit.accountType } }));
        console.log(chalk.green(`\n  Deposit credited by Aster.`));
        console.log(`  Amount:  ${amount} ${asset}`);
        if (res.approveTxHash !== null) console.log(`  Approve: ${res.approveTxHash}`);
        console.log(`  TX Hash: ${res.depositTxHash}\n`);
      } catch (err) {
        logFailure("aster", asset, "deposit", amount, err, { method: "vault", chain });
        throw err;
      }
    });

  // ═══ Aster withdraw — POST /fapi/v3/aster/user-withdraw ═══

  {
    const def = getVenue("aster");
    const assets = def.capabilities?.withdrawAssets;
    if (assets === null || assets === undefined || assets.length === 0) throw new Error("aster declares no withdrawAssets but has a withdraw command");
    supportsDryRun(withdraw.command("aster <amount>"))
      .description(`Withdraw ${assets.join(" or ")} from Aster perps to your own address on BNB Chain or Arbitrum (mainnet only; needs an API wallet approved with --can-withdraw --ip-whitelist; supports --dry-run)`)
      .option("--chain <chain>", "Destination chain: bsc | arbitrum", "bsc")
      .option("--asset <asset>", `Asset to withdraw: ${assets.join(" | ")}`, assets[0])
      .option("--to <address>", "Destination EVM address (must be the account's own address — the default)")
      .action(async (amount: string, opts: { chain: string; asset: string; to?: string }) => {
        const asset = opts.asset.toUpperCase();
        if (!assets.includes(asset)) {
          throw new PerpError("INVALID_PARAMS", `Aster withdraws ${assets.join(" / ")} only (got "${opts.asset}")`, { remediation: `Use --asset ${assets.join(" or --asset ")}` });
        }
        const net = getNetwork();
        const { requireAsterFundsNetwork, asterFundsChain } = await import("../exchanges/aster-funds.js");
        requireAsterFundsNetwork(net, "withdraw");
        const chain = asterFundsChain(opts.chain);
        const pins = ASTER_FUNDS_CHAINS[chain];
        if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
          throw new PerpError("INVALID_PARAMS", `Withdraw amount must be a positive decimal (got "${amount}")`);
        }
        if (isDryRun()) {
          return printFundsPlan({
            action: "withdraw", venue: "aster", network: net, asset, amount, chain: pins.label, chainId: pins.chainId,
            destination: opts.to !== undefined ? opts.to : "the account's own address",
            fee: "read from POST /fapi/v3/aster/user-withdraw-info at send time (amount must exceed it; it is taken from the amount)",
            signatures: "master wallet EIP-712 \"Aster\" withdraw message + API wallet (canWithdraw, IP whitelist) request signature",
            note: "POST /fapi/v3/aster/user-withdraw; Aster only pays the account's own address",
          });
        }
        await ctx.requireMaster("aster", "Aster withdraw");
        const { AsterAdapter } = await import("../exchanges/aster.js");
        const adapter = await getAdapterForExchange("aster");
        if (!(adapter instanceof AsterAdapter)) throw new Error("aster venue did not produce an AsterAdapter");
        const owner = adapter.userAddress;
        if (opts.to !== undefined && opts.to.toLowerCase() !== owner.toLowerCase()) {
          throw new PerpError("INVALID_PARAMS", `Aster only withdraws to the account's own address ${owner}`, { remediation: `Omit --to (defaults to ${owner})` });
        }
        if (!isJson()) {
          console.log(chalk.cyan(`\n  Withdrawing ${amount} ${asset} from Aster...\n`));
          console.log(`  Destination: ${owner} (${pins.label})`);
        }
        try {
          const result = await adapter.withdraw(amount, owner, { chain, asset });
          logExecution({
            type: "bridge", exchange: "aster", symbol: asset, side: "withdraw", size: amount, status: "success", dryRun: false,
            meta: { action: "withdraw", destination: owner, chain, withdrawId: result.withdrawId, fee: result.fee },
          });
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.green(`\n  Withdrawal accepted by Aster.`));
          console.log(`  Amount: ${amount} ${asset} (fee ${result.fee} ${asset} taken from it)`);
          console.log(`  Withdraw id: ${result.withdrawId}`);
          console.log(chalk.gray(`\n  Track it in the Aster app (Assets → History) until it arrives on ${pins.label}.\n`));
        } catch (err) {
          logFailure("aster", asset, "withdraw", amount, err, { destination: owner, chain });
          throw err;
        }
      });
  }

  // ═══ Ondo deposit — USDC transfer to the account's funding address ═══

  supportsDryRun(deposit.command("ondo <amount>"))
    .description("Deposit USDC into Ondo Perps: ERC-20 transfer to the account's funding address on Arbitrum or Ethereum (mainnet only; --probe sends a small amount first; supports --dry-run)")
    .option("--chain <chain>", "Source chain: arbitrum | ethereum", "arbitrum")
    .option("--probe <amount>", "Send this amount first, wait until Ondo credits it, then send the rest")
    .action(async (amount: string, opts: { chain: string; probe?: string }) => {
      const net = getNetwork();
      const f = await import("../exchanges/ondo/funds.js");
      f.requireOndoDepositNetwork(net);
      const chain = f.ondoDepositChain(opts.chain);
      parsePositiveDecimal(amount, "amount");
      const probe = opts.probe === undefined ? null : parsePositiveDecimal(opts.probe, "--probe");
      const pins = ONDO_DEPOSIT_CHAINS[chain];
      if (isDryRun()) {
        return printFundsPlan({
          action: "deposit", venue: "ondo", network: net, asset: "USDC", amount, chain: pins.label, chainId: pins.chainId, token: pins.usdc,
          probe: probe === null ? "none (single transfer)" : probe, signer: "OWS master wallet",
          destination: `first listed USDC ${chain} funding address of this account (POST /v1/wallet/deposit_address/list; provisioned only when none exists)`,
          steps: probe === null
            ? "USDC transfer → wait for the credit (GET /v1/wallet/deposits)"
            : `USDC transfer of ${probe} (probe) → wait for the credit → USDC transfer of the remainder → wait for the credit (the remainder is NOT sent while the probe is uncredited)`,
          checks: "eth_chainId, on-chain decimals(), USDC balance, ETH gas, funding address belongs to this account",
        });
      }
      const { loadMasterEvmSigner } = await import("../evm-master-tx.js");
      const signer = await loadMasterEvmSigner("ondo", creds(), "Ondo deposit");
      const { OndoAdapter } = await import("../exchanges/ondo/adapter.js");
      const adapter = await getAdapterForExchange("ondo");
      if (!(adapter instanceof OndoAdapter)) throw new Error("ondo venue did not produce an OndoAdapter");
      const client = adapter.restClient;
      const funding = await f.resolveOndoDepositAddress(client, chain);
      const plan = await f.planOndoDeposit({ network: net, chain, amount, probe, depositor: signer.getAddress(), funding });
      const view = {
        venue: "ondo", network: net, asset: "USDC", amount, probe, depositor: plan.depositor, chain: plan.chainLabel, chainId: plan.chainId,
        token: plan.token, depositAddress: plan.depositAddress, accountId: plan.accountId, addressProvisioned: funding.provisioned,
      };
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing ${amount} USDC into Ondo Perps from ${plan.chainLabel}...\n`));
        console.log(`  From: ${plan.depositor}`);
        console.log(`  To:   ${plan.depositAddress} (funding address of account ${plan.accountId}${funding.provisioned ? ", newly provisioned" : ""})`);
        if (probe !== null) console.log(chalk.gray(`  Probe: ${probe} USDC first; the rest follows once it is credited.`));
      }
      try {
        const res = await f.executeOndoDeposit(plan, tx => signer.signTransaction(tx), () => client.get<unknown>("/v1/wallet/deposits", null), {
          timeoutMs: f.ONDO_DEPOSIT_CREDIT_TIMEOUT_MS, pollMs: f.ONDO_DEPOSIT_CREDIT_POLL_MS, sleep: realSleep, now: () => Date.now(),
        });
        logExecution({
          type: "bridge", exchange: "ondo", symbol: "USDC", side: "deposit", size: amount, status: "success", dryRun: false,
          meta: { action: "deposit", method: "transfer", chain, depositAddress: plan.depositAddress, txHashes: res.transfers.map(t => t.txHash) },
        });
        if (isJson()) return printJson(jsonOk({ ...view, ...res, method: "transfer", credited: true }));
        console.log(chalk.green(`\n  Deposit credited by Ondo Perps.`));
        for (const t of res.transfers) console.log(`  ${t.step === "probe" ? "Probe  " : "Deposit"} ${t.amount} USDC: ${t.txHash}`);
        console.log();
      } catch (err) {
        logFailure("ondo", "USDC", "deposit", amount, err, { method: "transfer", chain, depositAddress: plan.depositAddress });
        throw err;
      }
    });

  // ═══ Address book (Ondo withdrawal destinations) ═══
  // Ondo Perps withdrawals are web-app only (the API does not allow them), so an address-book
  // entry made here would serve nothing. The command stays so the refusal is explicit.

  const addressBook = funds.command("address-book").description("Not available: the Ondo Perps withdrawal address book is managed in the web app");

  supportsDryRun(addressBook.command("add <venue> <address>"))
    .description("Not available: Ondo Perps withdrawals and their address book are web-app only (refused, also with --dry-run)")
    .option("--label <text>", "Ignored")
    .action(async (venue: string) => {
      const def = getVenue(venue);
      throw unsupported(def.displayName, "address-book", "the Ondo Perps API does not allow withdrawals, so the CLI keeps no withdrawal address book", "Manage withdrawals and the address book in the Ondo Perps web app");
    });
}
