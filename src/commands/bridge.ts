import { parsePositiveDecimal } from "../errors.js";
import { Command } from "commander";
import { isDryRun, supportsDryRun } from "../cli-flags.js";
import chalk from "chalk";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import { logExecution } from "../execution-log.js";
import {
  getDebridgeQuote,
  executeDebridgeBridge,
  executeBestBridge,
  getBestQuote,
  getAllQuotes,
  checkDebridgeStatus,
  checkBridgeGasBalance,
  assertBridgeNetwork,
  assertDistinctBridgeChains,
  assertCctpRouteSupported,
  parseUsdcAmount,
  CHAIN_IDS,
  USDC_ADDRESSES,
  EXCHANGE_TO_CHAIN,
  type BridgeQuote,
} from "../bridge-engine.js";
import { cliCredentialOptsFrom, type CliCredentialOpts } from "../config.js";
import type { Network, VenueId } from "../exchanges/venue-types.js";
import { PerpError } from "../errors.js";
import { CCTP_DOMAINS } from "../bridge-engine.js";
import { RELAY_CHAINS, relayAsset, relayChain, type RelaySwapQuote } from "../relay-swap.js";
import { bridgeAddress, bridgeVenueForChain, loadBridgeSigner } from "../bridge-signers.js";

/** Chains only the Relay path serves (not in the CCTP / deBridge tables): robinhood, bsc. */
function relayOnlyChain(chain: string): boolean {
  return chain in RELAY_CHAINS && !(chain in CCTP_DOMAINS) && !(chain in CHAIN_IDS);
}

type UsdcProvider = "cctp" | "relay" | "debridge";

function rootCredOpts(cmd: Command): CliCredentialOpts {
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return cliCredentialOptsFrom(root.opts());
}

function parseProvider(raw: string | undefined): UsdcProvider | undefined {
  if (raw === undefined) return undefined;
  const p = raw.toLowerCase();
  if (p === "cctp" || p === "relay" || p === "debridge") return p;
  throw new PerpError("INVALID_PARAMS", `Invalid provider: ${raw}`, { remediation: "Use --provider cctp, relay, or debridge (or omit it for the best quote)" });
}

/** The quote to execute: the forced provider's, else the best (quotes are sorted by amountOut). */
function pickQuote(quotes: BridgeQuote[], provider: UsdcProvider | undefined, srcChain: string, dstChain: string): BridgeQuote {
  if (quotes.length === 0) {
    throw new PerpError("NO_BRIDGE_ROUTE", `No bridge available for ${srcChain} → ${dstChain}`, {
      remediation: "Check supported chains / routes: perp funds bridge chains",
    });
  }
  if (provider === undefined) return quotes[0];
  const match = quotes.find(q => q.provider === provider);
  if (!match) {
    throw new PerpError("NO_BRIDGE_ROUTE", `Provider "${provider}" is not available for ${srcChain} → ${dstChain}`, {
      remediation: `Drop --provider to use the best available route (available: ${quotes.map(q => q.provider).join(", ")})`,
    });
  }
  return match;
}

/**
 * JSON view of a quote. A Relay quote's raw payload carries the verified transactions (BigInt
 * values, not JSON-serializable): shown as step kinds, as `relaySend` does.
 */
function quoteJson(q: BridgeQuote): BridgeQuote {
  if (q.provider !== "relay") return q;
  const { txs, ...rest } = q.raw as RelaySwapQuote;
  return { ...q, raw: { ...rest, steps: txs.map(t => t.kind) } };
}

/** Gas preflight result → INSUFFICIENT_BALANCE before anything is signed. */
function assertBridgeGas(gasCheck: { ok: boolean; errors: string[] }, needsDstGas: boolean): void {
  if (gasCheck.ok) return;
  throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient gas for bridge — nothing was sent:\n${gasCheck.errors.map(e => `  ✗ ${e}`).join("\n")}`, {
    gas: gasCheck.errors,
    remediation: needsDstGas
      ? "Fund the native gas token on the chains listed, or use --fast (Circle auto-relays; no destination gas needed)"
      : "Fund the native gas token on the chains listed, then retry",
  });
}

/** Execute through the engine; ORDER_PENDING (sent, outcome unknown) is logged as unverified, never as failed. */
async function executeLogged(
  side: string, amount: string, fast: boolean, run: () => ReturnType<typeof executeBestBridge>,
): ReturnType<typeof executeBestBridge> {
  try {
    const result = await run();
    logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side, size: amount, status: "success", dryRun: false, meta: { provider: result.provider, txHash: result.txHash, fast } });
    return result;
  } catch (err) {
    const pending = err instanceof PerpError && err.structured.code === "ORDER_PENDING";
    const txHash = err instanceof PerpError ? err.structured.details?.txHash : undefined;
    logExecution({
      type: "bridge", exchange: "bridge", symbol: "USDC", side, size: amount, status: pending ? "unverified" : "failed", dryRun: false,
      error: err instanceof Error ? err.message : String(err),
      meta: { fast, ...(typeof txHash === "string" ? { txHash } : {}) },
    });
    throw err;
  }
}

interface RelaySendOpts {
  from: string; to: string; amount: string;
  sender?: string; recipient?: string; fromAsset?: string; toAsset?: string; minOut?: string; fast?: boolean;
}

/**
 * `funds bridge send` through Relay (any pinned asset pair, EVM origin, OWS master wallet).
 * Dry run: the verified quote + the output-protection verdict, no key loaded, nothing sent.
 * Live: sender and recipient are the master wallet's own addresses (no arbitrary recipient).
 */
async function relaySend(opts: RelaySendOpts, cmd: Command, isJson: () => boolean, getNetwork: () => Network): Promise<void> {
  const dryRun = isDryRun(cmd);
  const src = opts.from.toLowerCase();
  const dst = opts.to.toLowerCase();
  const fromAsset = (opts.fromAsset === undefined ? "USDC" : opts.fromAsset).toUpperCase();
  const toAsset = (opts.toAsset === undefined ? "USDC" : opts.toAsset).toUpperCase();
  const amount = parsePositiveDecimal(opts.amount, "--amount");
  const minOut = opts.minOut === undefined ? null : parsePositiveDecimal(opts.minOut, "--min-out");
  if (opts.fast === true) throw new PerpError("INVALID_PARAMS", "--fast is a CCTP option; Relay fills in seconds", { remediation: "Drop --fast" });
  const origin = relayChain(src);
  const dest = relayChain(dst);
  relayAsset(src, fromAsset);
  relayAsset(dst, toAsset);
  if (origin.vm !== "evm") {
    throw new PerpError("NO_BRIDGE_ROUTE", `Relay: bridging FROM ${origin.label} is not implemented (only EVM-origin deposits are verified and signed)`, {
      remediation: "Bridge from an EVM chain, or use --provider cctp / debridge for a Solana-origin USDC bridge",
    });
  }

  const credOpts = rootCredOpts(cmd);
  /** The master wallet's own address on a chain family — public address only, nothing is decrypted. */
  const ownAddress = async (vm: "evm" | "svm"): Promise<string> => {
    const { resolveOwsMaster } = await import("../config.js");
    const m = await resolveOwsMaster("hyperliquid", credOpts);
    if (m === null) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Relay bridging is signed by the OWS master wallet, which is not selected on this computer", {
        remediation: dryRun
          ? "For a dry run without a wallet pass both --sender <address> and --recipient <address>; otherwise select the master wallet (--ows <name> / perp wallet use <name>)"
          : "Import the master wallet into the OWS vault (perp wallet import --name <name> --chain evm), then perp wallet use <name> or pass --ows <name>",
      });
    }
    if (vm === "evm") return (await import("../signer/ows-evm.js")).OwsEvmSigner.create(m.wallet, m.passphrase).getAddress();
    return (await import("../signer/ows-solana.js")).OwsSolanaSigner.create(m.wallet, m.passphrase).getPublicKeyBase58();
  };
  const same = (vm: "evm" | "svm", a: string, b: string): boolean => (vm === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

  let sender: string;
  let recipient: string;
  if (dryRun) {
    sender = opts.sender === undefined ? await ownAddress("evm") : opts.sender;
    recipient = opts.recipient === undefined ? await ownAddress(dest.vm) : opts.recipient;
  } else {
    sender = await ownAddress("evm");
    recipient = await ownAddress(dest.vm);
    if (opts.sender !== undefined && !same("evm", opts.sender, sender)) {
      throw new PerpError("INVALID_PARAMS", `--sender ${opts.sender} is not the master wallet (${sender})`, { remediation: "Omit --sender" });
    }
    if (opts.recipient !== undefined && !same(dest.vm, opts.recipient, recipient)) {
      throw new PerpError("POLICY_DENIED", `Relay bridging only pays the master wallet's own ${dest.label} address ${recipient}; --recipient ${opts.recipient} is refused`, {
        remediation: "Omit --recipient (the master wallet's own address on the destination chain is used)",
      });
    }
  }

  if (!isJson()) console.log(chalk.cyan(`\n  Relay bridge: ${amount} ${fromAsset} (${origin.label}) → ${toAsset} (${dest.label})\n`));
  const { quoteRelaySwap, relayMinOutVerdict, assertRelayMinOut, executeRelaySwap } = await import("../relay-swap.js");
  const quote: RelaySwapQuote = await quoteRelaySwap({ from: src, to: dst, fromAsset, toAsset, amount, sender, recipient });
  const verdict = relayMinOutVerdict(quote, minOut);
  const { txs, ...quoteView } = quote;
  const view = { ...quoteView, steps: txs.map(t => t.kind) };

  if (!isJson()) {
    console.log(`  From:          ${sender} (${origin.label})`);
    console.log(`  To:            ${recipient} (${dest.label})`);
    console.log(`  Amount in:     ${quote.amountIn} ${fromAsset}${quote.amountInUsd !== null ? ` (~$${quote.amountInUsd})` : ""}`);
    console.log(`  Expected out:  ${quote.expectedOut} ${toAsset}${quote.expectedOutUsd !== null ? ` (~$${quote.expectedOutUsd})` : ""}`);
    console.log(`  Guaranteed:    ${quote.minimumOut} ${toAsset} (protocol-enforced minimum)`);
    console.log(`  Fees:          relayer $${quote.fees.relayerUsd}${quote.fees.originGasUsd !== null ? `, origin gas ~$${quote.fees.originGasUsd}` : ""}${quote.totalImpactPercent !== null ? ` (total impact ${quote.totalImpactPercent}%)` : ""}`);
    console.log(`  ETA:           ${quote.timeEstimateSec === null ? "unknown" : `~${quote.timeEstimateSec}s`}`);
    console.log(`  Steps:         ${view.steps.join(" → ")}`);
    console.log(`  Min-out check: ${verdict.ok ? chalk.green("ok") : chalk.red("REFUSED")} — ${verdict.reason}\n`);
  }

  if (dryRun) {
    logExecution({ type: "bridge", exchange: "bridge", symbol: fromAsset, side: `${src}->${dst}`, size: amount, status: "simulated", dryRun: true, meta: { provider: "relay", requestId: quote.requestId, toAsset } });
    if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, provider: "relay", quote: view, minOut: verdict }));
    console.log(chalk.yellow("  [DRY RUN] Nothing was signed or sent.\n"));
    return;
  }

  assertRelayMinOut(quote, minOut);
  const { loadMasterEvmSigner } = await import("../evm-master-tx.js");
  const signer = await loadMasterEvmSigner("hyperliquid", credOpts, "Relay bridge");
  if (!same("evm", signer.getAddress(), sender)) {
    throw new PerpError("INVALID_PARAMS", `Relay: signer ${signer.getAddress()} is not the quoted sender ${sender} — nothing was sent`, { remediation: "Omit --sender" });
  }
  try {
    const result = await executeRelaySwap(getNetwork(), quote, tx => signer.signTransaction(tx));
    logExecution({ type: "bridge", exchange: "bridge", symbol: fromAsset, side: `${src}->${dst}`, size: amount, status: "success", dryRun: false, meta: { provider: "relay", requestId: result.requestId, txHash: result.depositTxHash, toAsset } });
    if (isJson()) return printJson(jsonOk(result));
    console.log(chalk.green("  Bridge filled."));
    if (result.approveTxHash !== null) console.log(`  Approve:    ${result.approveTxHash}`);
    console.log(`  Deposit:    ${result.depositTxHash} (${origin.label})`);
    for (const h of result.destinationTxHashes) console.log(`  Fill:       ${h} (${dest.label})`);
    console.log(`  Request id: ${result.requestId}\n`);
  } catch (err) {
    const pending = err instanceof PerpError && err.structured.code === "ORDER_PENDING";
    const txHash = err instanceof PerpError ? err.structured.details?.txHash : undefined;
    logExecution({
      type: "bridge", exchange: "bridge", symbol: fromAsset, side: `${src}->${dst}`, size: amount, status: pending ? "unverified" : "failed", dryRun: false,
      error: err instanceof Error ? err.message : String(err),
      meta: { provider: "relay", requestId: quote.requestId, toAsset, ...(typeof txHash === "string" ? { txHash } : {}) },
    });
    throw err;
  }
}

export function registerFundsBridgeCommands(
  parent: Command,
  isJson: () => boolean,
  getNetwork: () => Network,
) {
  const bridge = parent.command("bridge").description("Cross-chain USDC bridge (multi-provider: cctp, relay, debridge — auto-cheapest)");

  // ── bridge chains ──

  bridge
    .command("chains")
    .description("List supported chains and USDC addresses")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({ chains: CHAIN_IDS, usdc: USDC_ADDRESSES, exchanges: EXCHANGE_TO_CHAIN, relay: RELAY_CHAINS }));
      }

      console.log(chalk.cyan.bold("\n  Supported Bridge Chains\n"));
      const rows = Object.entries(CHAIN_IDS).map(([chain, id]) => [
        chalk.white.bold(chain),
        String(id),
        USDC_ADDRESSES[chain] ? chalk.green("USDC") : chalk.gray("-"),
        USDC_ADDRESSES[chain] ? chalk.gray(USDC_ADDRESSES[chain].slice(0, 10) + "...") : "",
      ]);
      console.log(makeTable(["Chain", "Chain ID", "Token", "Address"], rows));

      console.log(chalk.cyan.bold("  Exchange → Chain Mapping\n"));
      for (const [ex, chain] of Object.entries(EXCHANGE_TO_CHAIN)) {
        console.log(`  ${chalk.white.bold(ex.padEnd(14))} → ${chain}`);
      }
      console.log(chalk.cyan.bold("\n  Relay chains / assets (--provider relay, --from-asset / --to-asset)\n"));
      for (const [name, def] of Object.entries(RELAY_CHAINS)) {
        console.log(`  ${chalk.white.bold(name.padEnd(14))} ${String(def.chainId).padEnd(10)} ${Object.keys(def.assets).join(", ")}`);
      }
      console.log(chalk.gray("\n  Providers: Circle CCTP, Relay, deBridge DLN\n"));
    });

  // ── bridge quote ──

  bridge
    .command("quote")
    .description("Get bridge quotes from all providers")
    .requiredOption("--from <chain>", "Source chain (solana, arbitrum, base)")
    .requiredOption("--to <chain>", "Destination chain")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--sender <address>", "Source address (default: the master wallet's own address on --from; public address only, nothing decrypted)")
    .option("--recipient <address>", "Destination address (default: the master wallet's own address on --to)")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string;
    }, cmd: Command) => {
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      assertDistinctBridgeChains(srcChain, dstChain);
      assertCctpRouteSupported(srcChain, dstChain);
      const amount = parseUsdcAmount(opts.amount, "--amount"); // exact decimal string (≤ 6 decimals)

      // Omitted addresses are the master wallet's own public addresses (OWS: vault account list).
      const credOpts = rootCredOpts(cmd);
      const sender = opts.sender ?? await bridgeAddress(srcChain, bridgeVenueForChain(srcChain), credOpts);
      const recipient = opts.recipient ?? await bridgeAddress(dstChain, bridgeVenueForChain(dstChain), credOpts);

      if (!isJson()) console.log(chalk.cyan(`\n  Fetching quotes: $${amount} USDC ${srcChain} → ${dstChain}...\n`));

      const quotes = await getAllQuotes(srcChain, dstChain, amount, sender, recipient);

      if (quotes.length === 0) {
        throw new PerpError("NO_BRIDGE_ROUTE", `No bridge provider quoted ${srcChain} → ${dstChain}`, {
          remediation: "Check supported chains / routes: perp funds bridge chains",
        });
      }
      if (isJson()) return printJson(jsonOk({ quotes: quotes.map(quoteJson) }));

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      const rows = quotes.map((q, i) => {
        const tag = i === 0 ? chalk.green(" ★ BEST") : "";
        const name = PROVIDER_NAMES[q.provider] ?? q.provider;
        const usdcFee = q.fee <= 0 && !q.nativeFee ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
          const feeStr = q.nativeFee ? `${usdcFee} + ${q.nativeFee.amount} ${q.nativeFee.symbol}${q.nativeFee.usd !== null ? ` (≈$${formatUsd(q.nativeFee.usd)})` : " (unpriced)"}` : usdcFee;
        const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
        const gasTag = q.gasIncluded
          ? chalk.green("included")
          : chalk.yellow("dst gas needed");
        return [
          (i === 0 ? chalk.green.bold(name) : chalk.white(name)) + tag,
          `$${formatUsd(q.amountOut)}`,
          `${feeStr} (${pct}%)`,
          `~${q.estimatedTime}s`,
          gasTag,
        ];
      });

      console.log(chalk.cyan.bold(`  Bridge Quotes: $${formatUsd(Number(amount))} USDC ${srcChain} → ${dstChain}\n`));
      console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));

      // Show gas notes per provider
      for (const q of quotes) {
        if (q.gasNote) {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          console.log(chalk.gray(`  ${name}: ${q.gasNote}`));
        }
      }
      console.log();
      console.log(chalk.gray(`  Execute with: perp funds bridge send --from ${srcChain} --to ${dstChain} --amount ${opts.amount}`));
      console.log(chalk.gray(`  Pick provider: --provider cctp|relay|debridge\n`));
    });

  // ── bridge send ──

  supportsDryRun(bridge.command("send"))
    .description("Execute a bridge transaction — USDC by default; any pinned asset pair through Relay with --from-asset / --to-asset (supports --dry-run: quotes only, nothing sent)")
    .requiredOption("--from <chain>", "Source chain")
    .requiredOption("--to <chain>", "Destination chain")
    .requiredOption("--amount <amount>", "Amount of the source asset (USDC unless --from-asset)")
    .option("--from-asset <symbol>", "Relay: source asset (e.g. USDG, USDC, USDT, ETH; default USDC)")
    .option("--to-asset <symbol>", "Relay: destination asset (e.g. USDC, USDT, SOL, ETH; default USDC)")
    .option("--min-out <amount>", "Relay: minimum output accepted, in the destination asset (required for stable → native)")
    .option("--sender <address>", "Source address (auto-detected from key; live: must be this wallet's own address)")
    .option("--recipient <address>", "Destination address (live: must be this wallet's own address on the destination chain; any other is refused)")
    .option("--provider <name>", "Force provider: cctp, relay, debridge (default: cheapest)")
    .option("--fast", "Use fast finality (~1-2 min, $1-1.3 fee, auto-relay). Default: standard (~13-20 min, $0.01, manual relay)")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string; provider?: string; fast?: boolean;
      fromAsset?: string; toAsset?: string; minOut?: string;
    }, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      // Mainnet-only routes: refuse -n testnet before any key is loaded.
      assertBridgeNetwork(getNetwork());
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      // Before any key is loaded or quote fetched.
      assertDistinctBridgeChains(srcChain, dstChain);
      assertCctpRouteSupported(srcChain, dstChain);

      // Relay path: asked for by name, by an asset / min-out flag, or implied by a Relay-only chain.
      const relayRoute = opts.provider?.toLowerCase() === "relay" || opts.fromAsset !== undefined || opts.toAsset !== undefined
        || opts.minOut !== undefined || relayOnlyChain(srcChain) || relayOnlyChain(dstChain);
      if (relayRoute) {
        if (opts.provider !== undefined && opts.provider.toLowerCase() !== "relay") {
          throw new PerpError("INVALID_PARAMS", `--from-asset / --to-asset / --min-out and the ${relayOnlyChain(srcChain) ? srcChain : dstChain} chain are served by Relay only, not "${opts.provider}"`, {
            remediation: "Use --provider relay (or drop --provider)",
          });
        }
        return relaySend(opts, cmd, isJson, getNetwork);
      }
      const amount = parseUsdcAmount(opts.amount, "--amount"); // exact decimal string (≤ 6 decimals)
      const chosenProvider = parseProvider(opts.provider);

      // Addresses are public (review L3): an address passed with --sender / --recipient needs no
      // wallet at all, and an omitted one is the master's own public address (OWS: the vault's
      // account list; nothing is decrypted). Signers are only loaded after the dry-run return.
      const credOpts = rootCredOpts(cmd);
      const addressOf = (chain: string): Promise<string> => bridgeAddress(chain, bridgeVenueForChain(chain), credOpts);
      const senderAddress = opts.sender ?? await addressOf(srcChain);
      const recipientAddress = opts.recipient ?? await addressOf(dstChain);

      // Fetch all quotes
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcChain} → ${dstChain}\n`));
      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
      const selectedQuote = pickQuote(quotes, chosenProvider, srcChain, dstChain);

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      if (!isJson()) {
        // Show comparison table
        const rows = quotes.map((q) => {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          const selected = q.provider === selectedQuote.provider;
          const usdcFee = q.fee <= 0 && !q.nativeFee ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
          const feeStr = q.nativeFee ? `${usdcFee} + ${q.nativeFee.amount} ${q.nativeFee.symbol}${q.nativeFee.usd !== null ? ` (≈$${formatUsd(q.nativeFee.usd)})` : " (unpriced)"}` : usdcFee;
          const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
          const tag = selected ? chalk.green(" ← selected") : "";
          const gasTag = q.gasIncluded
            ? chalk.green("included")
            : chalk.yellow("dst gas needed");
          return [
            (selected ? chalk.green.bold(name) : chalk.white(name)) + tag,
            `$${formatUsd(q.amountOut)}`,
            `${feeStr} (${pct}%)`,
            `~${q.estimatedTime}s`,
            gasTag,
          ];
        });
        console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));

        if (!selectedQuote.gasIncluded) {
          console.log(chalk.yellow(`  ⚠ ${selectedQuote.gasNote}`));
        }
        console.log(`  From:     ${senderAddress}`);
        console.log(`  To:       ${recipientAddress}\n`);
      }

      if (dryRun) {
        if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, quotes: quotes.map(quoteJson), selected: selectedQuote.provider }));
        console.log(chalk.yellow("  [DRY RUN] Transaction not executed.\n"));
        return;
      }

      // Own-address rule (same as the Relay path): a live bridge only moves funds from and to this
      // wallet's own addresses. --sender / --recipient may name them, nothing else.
      const sameAddr = (chain: string, a: string, b: string): boolean => chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();
      const ownSender = await addressOf(srcChain);
      if (!sameAddr(srcChain, senderAddress, ownSender)) {
        throw new PerpError("POLICY_DENIED", `Bridging signs with this wallet's own ${srcChain} address ${ownSender}; --sender ${senderAddress} is refused. Nothing was sent`, {
          remediation: "Omit --sender (the wallet's own address on the source chain is used)",
        });
      }
      const ownRecipient = await addressOf(dstChain);
      if (!sameAddr(dstChain, recipientAddress, ownRecipient)) {
        throw new PerpError("POLICY_DENIED", `Bridging only pays this wallet's own ${dstChain} address ${ownRecipient}; --recipient ${recipientAddress} is refused. Nothing was sent`, {
          remediation: "Omit --recipient (the wallet's own address on the destination chain is used)",
        });
      }

      // Gas balance preflight check (before any signer is loaded)
      const needsDstGas = !selectedQuote.gasIncluded;
      assertBridgeGas(await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas), needsDstGas);

      // Master signers (live only): OWS vault signer, or a raw-key signer. The destination signer
      // claims on the destination chain (CCTP EVM → Solana standard finality).
      const signer = await loadBridgeSigner(srcChain, bridgeVenueForChain(srcChain), credOpts);
      const dstSigner = await loadBridgeSigner(dstChain, bridgeVenueForChain(dstChain), credOpts);

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      // The provider shown as "selected" is the one executed.
      const result = await executeLogged(`${srcChain}->${dstChain}`, amount, !!opts.fast, () => executeBestBridge(
        getNetwork(), srcChain, dstChain, amount, signer, senderAddress, recipientAddress, dstSigner, selectedQuote.provider, !!opts.fast,
      ));

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge transaction submitted!"));
      console.log(`  TX Hash:  ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
      }
      console.log(chalk.gray(`\n  Funds arrive in ~${selectedQuote.estimatedTime}s on ${dstChain}.\n`));
    });

  // ── bridge between exchanges (shortcut) ──

  supportsDryRun(bridge.command("exchange"))
    .description("Bridge the master wallet's own USDC between the chains two exchanges settle on (wallet → wallet; does not withdraw from or deposit into Pacifica / Lighter — see --help; supports --dry-run: quotes only, nothing sent)")
    .requiredOption("--from <exchange>", `Source exchange (${Object.keys(EXCHANGE_TO_CHAIN).join(", ")})`)
    .requiredOption("--to <exchange>", "Destination exchange")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--provider <name>", "Force provider: cctp, relay, debridge (default: cheapest)")
    .option("--fast", "Use fast finality (~1-2 min, $1-1.3 fee, auto-relay)")
    .addHelpText("after", [
      "",
      "What this moves:",
      ...Object.entries(EXCHANGE_TO_CHAIN).map(([ex, chain]) => `  ${ex.padEnd(12)} → ${chain}`),
      "  pacifica / lighter: the master wallet's own USDC on Solana / Arbitrum (NOT the exchange account).",
      "    Withdraw first (perp funds withdraw ...) and deposit after arrival (perp funds deposit ...).",
      "  hyperliquid: HyperCore itself — --from spends the HyperCore spot USDC balance,",
      "    --to credits the HyperCore perps balance (CCTP forwarder).",
      "Same as: perp funds bridge send --from <chain> --to <chain> (sender / recipient = the master's own addresses).",
    ].join("\n"))
    .action(async (opts: { from: string; to: string; amount: string; provider?: string; fast?: boolean }, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      // Mainnet-only routes: refuse -n testnet before any key is loaded.
      assertBridgeNetwork(getNetwork());
      const srcExchange = opts.from.toLowerCase();
      const dstExchange = opts.to.toLowerCase();
      const srcChain = EXCHANGE_TO_CHAIN[srcExchange];
      const dstChain = EXCHANGE_TO_CHAIN[dstExchange];
      for (const [ex, chain] of [[srcExchange, srcChain], [dstExchange, dstChain]] as const) {
        if (chain === undefined) {
          throw new PerpError("INVALID_PARAMS", `Unknown exchange for bridging: ${ex}`, {
            remediation: `Use one of: ${Object.keys(EXCHANGE_TO_CHAIN).join(", ")} (see: perp funds bridge chains)`,
          });
        }
      }
      if (srcChain === dstChain) {
        throw new PerpError("INVALID_PARAMS", `${srcExchange} and ${dstExchange} are both on ${srcChain} — no bridge needed`, {
          remediation: "Pick exchanges on different chains (see: perp funds bridge chains)",
        });
      }

      assertCctpRouteSupported(srcChain, dstChain);
      const chosenProvider = parseProvider(opts.provider);

      const amount = parseUsdcAmount(opts.amount, "--amount"); // exact decimal string (≤ 6 decimals)
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcExchange} (${srcChain}) → ${dstExchange} (${dstChain})\n`));

      // The master wallet's own public addresses (OWS: vault account list; nothing is decrypted).
      const credOpts = rootCredOpts(cmd);
      const srcVenue = bridgeVenueForChain(srcChain, srcExchange as VenueId);
      const dstVenue = bridgeVenueForChain(dstChain, dstExchange as VenueId);
      const senderAddress = await bridgeAddress(srcChain, srcVenue, credOpts);
      const recipientAddress = await bridgeAddress(dstChain, dstVenue, credOpts);

      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
      const selectedQuote = pickQuote(quotes, chosenProvider, srcChain, dstChain);

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      if (!isJson()) {
        const rows = quotes.map((q) => {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          const selected = q.provider === selectedQuote.provider;
          const usdcFee = q.fee <= 0 && !q.nativeFee ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
          const feeStr = q.nativeFee ? `${usdcFee} + ${q.nativeFee.amount} ${q.nativeFee.symbol}${q.nativeFee.usd !== null ? ` (≈$${formatUsd(q.nativeFee.usd)})` : " (unpriced)"}` : usdcFee;
          const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
          const tag = selected ? chalk.green(" ← selected") : "";
          const gasTag = q.gasIncluded
            ? chalk.green("included")
            : chalk.yellow("dst gas needed");
          return [
            (selected ? chalk.green.bold(name) : chalk.white(name)) + tag,
            `$${formatUsd(q.amountOut)}`,
            `${feeStr} (${pct}%)`,
            `~${q.estimatedTime}s`,
            gasTag,
          ];
        });
        console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));
        if (!selectedQuote.gasIncluded) {
          console.log(chalk.yellow(`  ⚠ ${selectedQuote.gasNote}`));
        }
      }

      if (dryRun) {
        if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, quotes: quotes.map(quoteJson), selected: selectedQuote.provider }));
        console.log(chalk.yellow("  [DRY RUN] Not executed.\n"));
        return;
      }

      // Gas balance preflight check (before any signer is loaded)
      const needsDstGas = !selectedQuote.gasIncluded;
      assertBridgeGas(await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas), needsDstGas);

      const signer = await loadBridgeSigner(srcChain, srcVenue, credOpts);
      const dstSigner = await loadBridgeSigner(dstChain, dstVenue, credOpts);

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      // The provider shown as "selected" is the one executed.
      const result = await executeLogged(`${srcExchange}->${dstExchange}`, amount, !!opts.fast, () => executeBestBridge(
        getNetwork(), srcChain, dstChain, amount, signer, senderAddress, recipientAddress, dstSigner, selectedQuote.provider, !!opts.fast,
      ));

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge submitted!"));
      console.log(`  TX:       ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
      }
      if (dstChain === "hyperliquid") {
        console.log(chalk.gray(`\n  USDC is credited to the HyperCore perps balance on arrival.\n`));
      } else {
        console.log(chalk.gray(`\n  This moved wallet USDC on ${dstChain} only — the ${dstExchange} account is not funded yet.`));
        console.log(chalk.gray(`  After arrival, deposit separately: perp funds deposit ${dstExchange} --help\n`));
      }
    });

  // ── bridge status ──

  bridge
    .command("status <orderId>")
    .description("Check bridge order status")
    .action(async (orderId: string) => {
      const status = await checkDebridgeStatus(orderId);
      if (isJson()) return printJson(jsonOk(status));

      const state = String(status.status ?? status.orderStatus ?? "unknown");
      const stateColor = state.includes("Fulfilled") || state.includes("completed")
        ? chalk.green
        : state.includes("pending") ? chalk.yellow : chalk.white;

      console.log(chalk.cyan.bold("\n  Bridge Order Status\n"));
      console.log(`  Order ID: ${orderId}`);
      console.log(`  Status:   ${stateColor(state)}`);
      console.log();
    });
}
