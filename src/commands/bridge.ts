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
  CHAIN_IDS,
  USDC_ADDRESSES,
  EXCHANGE_TO_CHAIN,
  type BridgeQuote,
} from "../bridge-engine.js";
import { cliCredentialOptsFrom, type Exchange } from "../config.js";
import type { Network } from "../exchanges/venue-types.js";
import { PerpError } from "../errors.js";
import { CCTP_DOMAINS } from "../bridge-engine.js";
import { RELAY_CHAINS, relayAsset, relayChain, type RelaySwapQuote } from "../relay-swap.js";

/** Chains only the Relay path serves (not in the CCTP / deBridge tables): robinhood, bsc. */
function relayOnlyChain(chain: string): boolean {
  return chain in RELAY_CHAINS && !(chain in CCTP_DOMAINS) && !(chain in CHAIN_IDS);
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

  let root: Command = cmd;
  while (root.parent) root = root.parent;
  const credOpts = cliCredentialOptsFrom(root.opts());
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
  if (!same("evm", signer.getAddress(), sender)) throw new Error(`relay: signer ${signer.getAddress()} is not the quoted sender ${sender}`);
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
    .option("--sender <address>", "Source address")
    .option("--recipient <address>", "Destination address")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string;
    }) => {
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      const amount = Number(parsePositiveDecimal(opts.amount, "--amount"));

      if (!isJson()) console.log(chalk.cyan(`\n  Fetching quotes: $${amount} USDC ${srcChain} → ${dstChain}...\n`));

      const quotes = await getAllQuotes(
        srcChain, dstChain, amount,
        opts.sender ?? "0x0000000000000000000000000000000000000000",
        opts.recipient ?? "0x0000000000000000000000000000000000000000",
      );

      if (isJson()) return printJson(jsonOk({ quotes }));

      if (quotes.length === 0) {
        console.log(chalk.red("  No providers available for this route.\n"));
        return;
      }

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      const rows = quotes.map((q, i) => {
        const tag = i === 0 ? chalk.green(" ★ BEST") : "";
        const name = PROVIDER_NAMES[q.provider] ?? q.provider;
        const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
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

      console.log(chalk.cyan.bold(`  Bridge Quotes: $${formatUsd(amount)} USDC ${srcChain} → ${dstChain}\n`));
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
      const amount = Number(parsePositiveDecimal(opts.amount, "--amount"));
      if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

      const chosenProvider = opts.provider?.toLowerCase() as "cctp" | "relay" | "debridge" | undefined;
      if (chosenProvider && !["cctp", "relay", "debridge"].includes(chosenProvider)) {
        throw new Error(`Invalid provider: ${opts.provider}. Use cctp, relay, or debridge.`);
      }

      // Keys are loaded lazily (review L3): an address passed with --sender / --recipient needs no
      // key, so `--dry-run --sender <a> --recipient <b>` decrypts nothing; signing keys are only
      // loaded after the dry-run return.
      const { loadPrivateKey, parseSolanaKeypair } = await import("../config.js");
      const { ethers } = await import("ethers");
      const keyCache = new Map<"pacifica" | "hyperliquid", string>();
      const keyFor = async (chain: string): Promise<string> => {
        const venue = chain === "solana" ? "pacifica" as const : "hyperliquid" as const;
        const hit = keyCache.get(venue);
        if (hit !== undefined) return hit;
        const pk = await loadPrivateKey(venue);
        keyCache.set(venue, pk);
        return pk;
      };
      const addressOf = async (chain: string): Promise<string> => {
        const pk = await keyFor(chain);
        return chain === "solana" ? parseSolanaKeypair(pk).publicKey.toBase58() : new ethers.Wallet(pk).address;
      };
      const senderAddress = opts.sender ?? await addressOf(srcChain);
      const recipientAddress = opts.recipient ?? await addressOf(dstChain);

      // Fetch all quotes
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcChain} → ${dstChain}\n`));
      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);

      if (quotes.length === 0) throw new Error(`No bridge available for ${srcChain} → ${dstChain}`);

      // Pick the quote to use
      let selectedQuote: BridgeQuote;
      if (chosenProvider) {
        const match = quotes.find(q => q.provider === chosenProvider);
        if (!match) throw new Error(`Provider "${chosenProvider}" not available for this route`);
        selectedQuote = match;
      } else {
        selectedQuote = quotes[0]; // best (sorted by amountOut)
      }

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
          const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
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
        if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, quotes, selected: selectedQuote.provider }));
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

      // Signing keys (live only). The destination key is used to claim on the destination chain.
      const signerKey = await keyFor(srcChain);
      const dstSignerKey = await keyFor(dstChain);

      // Gas balance preflight check
      const needsDstGas = !selectedQuote.gasIncluded;
      const gasCheck = await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas);
      if (!gasCheck.ok) {
        const msg = gasCheck.errors.map(e => `  ✗ ${e}`).join("\n");
        if (isJson()) return printJson({ ok: false, error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient gas for transaction", details: gasCheck.errors }, meta: { timestamp: new Date().toISOString() } });
        console.log(chalk.red("\n  Insufficient gas for bridge:\n"));
        console.log(chalk.red(msg));
        if (needsDstGas) {
          console.log(chalk.yellow("\n  Tip: use --fast to skip destination gas (Circle auto-relays)\n"));
        }
        process.exitCode = 1;
        return;
      }

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      let result: Awaited<ReturnType<typeof executeBestBridge>>;
      try {
        result = await executeBestBridge(getNetwork(), srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey, chosenProvider, !!opts.fast);
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcChain}->${dstChain}`, size: String(amount), status: "success", dryRun: false, meta: { provider: result.provider, txHash: result.txHash, fast: !!opts.fast } });
      } catch (err) {
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcChain}->${dstChain}`, size: String(amount), status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

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
    .description("Bridge USDC between exchanges (shortcut; supports --dry-run: quotes only, nothing sent)")
    .requiredOption("--from <exchange>", "Source exchange (pacifica, hyperliquid, lighter)")
    .requiredOption("--to <exchange>", "Destination exchange")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--provider <name>", "Force provider: cctp, relay, debridge (default: cheapest)")
    .option("--fast", "Use fast finality (~1-2 min, $1-1.3 fee, auto-relay)")
    .action(async (opts: { from: string; to: string; amount: string; provider?: string; fast?: boolean }, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      // Mainnet-only routes: refuse -n testnet before any key is loaded.
      assertBridgeNetwork(getNetwork());
      const srcExchange = opts.from.toLowerCase();
      const dstExchange = opts.to.toLowerCase();
      const srcChain = EXCHANGE_TO_CHAIN[srcExchange];
      const dstChain = EXCHANGE_TO_CHAIN[dstExchange];
      if (!srcChain) throw new Error(`Unknown exchange: ${srcExchange}`);
      if (!dstChain) throw new Error(`Unknown exchange: ${dstExchange}`);
      if (srcChain === dstChain) throw new Error("Same chain — no bridge needed");

      const chosenProvider = opts.provider?.toLowerCase() as "cctp" | "relay" | "debridge" | undefined;
      if (chosenProvider && !["cctp", "relay", "debridge"].includes(chosenProvider)) {
        throw new Error(`Invalid provider: ${opts.provider}. Use cctp, relay, or debridge.`);
      }

      const amount = Number(parsePositiveDecimal(opts.amount, "--amount"));
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcExchange} (${srcChain}) → ${dstExchange} (${dstChain})\n`));

      // Load keys
      const { loadPrivateKey, parseSolanaKeypair } = await import("../config.js");
      let senderAddress: string;
      let recipientAddress: string;
      let signerKey: string;

      // Source
      if (srcChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        senderAddress = parseSolanaKeypair(pk).publicKey.toBase58();
        signerKey = pk;
      } else {
        const pk = await loadPrivateKey(srcExchange as Exchange);
        const { ethers } = await import("ethers");
        senderAddress = new ethers.Wallet(pk).address;
        signerKey = pk;
      }

      // Destination
      let dstSignerKey: string | undefined;
      if (dstChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        recipientAddress = parseSolanaKeypair(pk).publicKey.toBase58();
        dstSignerKey = pk;
      } else {
        const pk = await loadPrivateKey(dstExchange as Exchange);
        const { ethers } = await import("ethers");
        recipientAddress = new ethers.Wallet(pk).address;
        dstSignerKey = pk;
      }

      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
      if (quotes.length === 0) throw new Error(`No bridge available for ${srcChain} → ${dstChain}`);

      let selectedQuote: BridgeQuote;
      if (chosenProvider) {
        const match = quotes.find(q => q.provider === chosenProvider);
        if (!match) throw new Error(`Provider "${chosenProvider}" not available for this route`);
        selectedQuote = match;
      } else {
        selectedQuote = quotes[0];
      }

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      if (!isJson()) {
        const rows = quotes.map((q) => {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          const selected = q.provider === selectedQuote.provider;
          const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
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
        if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, quotes, selected: selectedQuote.provider }));
        console.log(chalk.yellow("  [DRY RUN] Not executed.\n"));
        return;
      }

      // Gas balance preflight check
      const needsDstGas = !selectedQuote.gasIncluded;
      const gasCheck = await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas);
      if (!gasCheck.ok) {
        const msg = gasCheck.errors.map(e => `  ✗ ${e}`).join("\n");
        if (isJson()) return printJson({ ok: false, error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient gas for transaction", details: gasCheck.errors }, meta: { timestamp: new Date().toISOString() } });
        console.log(chalk.red("\n  Insufficient gas for bridge:\n"));
        console.log(chalk.red(msg));
        if (needsDstGas) {
          console.log(chalk.yellow("\n  Tip: use --fast to skip destination gas (Circle auto-relays)\n"));
        }
        process.exitCode = 1;
        return;
      }

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      let result: Awaited<ReturnType<typeof executeBestBridge>>;
      try {
        result = await executeBestBridge(getNetwork(), srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey, chosenProvider, !!opts.fast);
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcExchange}->${dstExchange}`, size: String(amount), status: "success", dryRun: false, meta: { provider: result.provider, txHash: result.txHash, fast: !!opts.fast } });
      } catch (err) {
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcExchange}->${dstExchange}`, size: String(amount), status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge submitted!"));
      console.log(`  TX:       ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
        console.log(chalk.green(`  USDC arrived on ${dstExchange}!`));
      }
      console.log(chalk.gray(`\n  After arrival, deposit into ${dstExchange}:`));
      console.log(chalk.gray(`  perp funds deposit ${dstExchange} ${opts.amount}\n`));
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
