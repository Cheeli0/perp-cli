/**
 * The perp CLI Commander tree (root options + every command group), built without
 * parsing argv — `src/index.ts` parses it; tests parse full argv through the same tree.
 */
import { Command } from "commander";
import { cliCredentialOptsFrom, hasCredentials, resolveCredentials, type CliCredentialOpts } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { getVenue, listVenues, resolveVenueId, READ_ONLY_CREDENTIALS, type VenueDefinition } from "./exchanges/venue.js";
import { registerAdapterNetwork } from "./exchanges/adapter-network.js";
import "./exchanges/venues/index.js";
import type { Network as VenueNetwork, VenueId } from "./exchanges/venue-types.js";
import { PerpError } from "./errors.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerOutcomeCommands } from "./commands/outcome.js";
import { registerTradeCommands } from "./commands/trade.js";
// manage commands now register under `wallet manage ...` via registerWalletCommands.
// stream commands removed — WS feeds still used by dashboard/event-stream internally
import { registerArbCommands } from "./commands/arb.js";
import { registerWalletCommands } from "./commands/wallet.js";
// bridge + rebalance now nested under `funds` — registered inside registerFundsCommands.
import { registerFundsCommands } from "./commands/funds.js";
// alert commands removed
import { registerArbAutoCommands } from "./commands/arb-auto.js";
import { registerArbManageCommands } from "./commands/arb/index.js";
// Agent commands now register under `wallet agent ...` via registerWalletCommands.
import { registerStrategyCommands } from "./commands/bot.js";
import { registerRiskCommands } from "./commands/risk.js";
import { registerHistoryCommands } from "./commands/history.js";
import { registerSettingsCommands } from "./commands/settings.js";
// dex commands merged into market (hip3) — use --dex flag for markets/balance
// `plan` is no longer top-level — registered as `strategy plan` inside
// registerStrategyCommands.
// funding merged into arb.ts
import { registerBacktestCommands } from "./commands/backtest.js";
import { registerPortfolioCommand } from "./commands/portfolio.js";
import { registerInitCommand } from "./commands/init.js";
import { registerAlertCommands } from "./commands/alerts.js";
import { setSharedApiNetwork } from "./shared-api.js";

import { registerBackgroundCommands } from "./commands/jobs.js";
import { addRootSafetyOptions, networkOf, isDryRun, installDryRunGuard } from "./cli-flags.js";

export interface CliProgram {
  program: Command;
  getAdapterForExchange: (rawExchange: string) => Promise<ExchangeAdapter>;
  isJson: () => boolean;
}

/**
 * Root-flag secret policy (review L10, SSOT Rule #3): a raw private key on argv (-k) is visible
 * in `ps`, shell history and CI logs — rejected with INVALID_PARAMS and an import remediation.
 * `--passphrase` is deprecated with a loud stderr warning (still accepted: existing scripts) —
 * OWS_PASSPHRASE / stdin are the supported channels.
 */
let _passphraseWarned = false;
export function assertNoArgvSecrets(root: Command): void {
  const o = root.opts() as { privateKey?: string; passphrase?: string };
  if (o.privateKey !== undefined) {
    throw new PerpError("INVALID_PARAMS", "-k/--private-key is rejected: a raw private key on the command line leaks via ps, shell history and logs", {
      remediation: "Import the key once (hidden prompt / stdin): printf '%s' \"$KEY\" | perp wallet set <exchange>, then select it with -w <name> or --ows <name>",
    });
  }
  if (o.passphrase !== undefined && !_passphraseWarned) {
    _passphraseWarned = true;
    process.stderr.write("[warn] --passphrase on the command line is DEPRECATED and visible in ps / shell history. Use the OWS_PASSPHRASE env var or pipe it on stdin.\n");
  }
}

export function buildProgram(opts: { defaultExchange: string; version: string }): CliProgram {
  const { defaultExchange, version } = opts;
  const program = new Command();
  addRootSafetyOptions(program);

  program
    .name("perp")
    .description(`Multi-DEX Perpetual Futures CLI (${listVenues().map(v => v.displayName).join(", ")})`)
    .version(version)
    .option("-e, --exchange <exchange>", `Exchange: ${listVenues().map(v => v.id).join(", ")} (default: ${defaultExchange})`, defaultExchange)
    .option("-k, --private-key <key>", "REJECTED — a raw key on argv leaks via ps / shell history. Import it instead: perp wallet set <exchange> (stdin)")
    .option("--json", "Output raw JSON (for piping)")
    .option("--fields <fields>", "Comma-separated fields to include in JSON output (e.g. totalEquity,positions)")
    .option("--ndjson", "Output newline-delimited JSON (one object per line for streaming)")
    .option("-w, --wallet <name>", "Use a specific wallet by name (from 'perp wallet list')")
    .option("--ows <name>", "Use an OWS (Open Wallet Standard) wallet by name")
    .option("--ows-key <token>", "OWS API key token (ows_key_...) for policy-gated agent access")
    .option("--no-agent", "Bypass agent wallet routing for this run; falls back to OWS master or PK direct")
    .option("--no-builder", "Never attach a configured builder fee (settings builder.<venue>) to this run's orders")
    .option("--passphrase <pp>", "DEPRECATED (visible in ps / shell history) — prefer OWS_PASSPHRASE env or stdin")
    .option("--dex <name>", "HIP-3 deployed perp dex name (Hyperliquid only)")
    .configureOutput({
      writeErr: (str) => {
        if (process.argv.includes("--json")) {
          const msg = str.replace(/^error:\s*/i, "").trim();
          // Use inline envelope (jsonError import not available in sync context)
          console.log(JSON.stringify({
            ok: false,
            error: { code: "CLI_ERROR", message: msg },
            meta: { timestamp: new Date().toISOString() },
          }));
        } else {
          process.stderr.write(str);
        }
      },
    });

  let _adapter: ExchangeAdapter | null = null;

  /**
   * One adapter per `${venueId}:${network}:${wallet}:${hlDex}` (design §3 L1 cache key).
   * Every adapter is built by the venue definition's create(ctx) — the single
   * creation path shared with the MCP server (design §10.2).
   */
  const _adapters = new Map<string, ExchangeAdapter>();

  function cliCredentialOpts(): CliCredentialOpts {
    return cliCredentialOptsFrom(program.opts());
  }

  function currentNetwork(): VenueNetwork {
    return networkOf(program);
  }

  function adapterCacheKey(venue: VenueId, network: VenueNetwork, hlDex: string | null): string {
    const opts = program.opts();
    const wallet = opts.ows ? `ows:${opts.ows as string}` : ((opts.wallet as string | undefined) ?? "default");
    return `${venue}:${network}:${wallet}:${hlDex ?? "-"}`;
  }

  /** restrictedRegions notice: stderr, once per venue per process (design §9.1 #2 — warn, never block). */
  const _restrictedWarned = new Set<VenueId>();
  function warnRestrictedRegions(def: VenueDefinition): void {
    if (def.restrictedRegions.length === 0 || _restrictedWarned.has(def.id)) return;
    _restrictedWarned.add(def.id);
    process.stderr.write(`[warn] ${def.displayName} is not available to residents of: ${def.restrictedRegions.join(", ")}. Check the venue terms before trading.\n`);
  }

  /**
   * `publicOnly`: build a read-only adapter (credentials never resolved) — used by the
   * public market-data commands so a configured-but-unusable credential (e.g. an OWS
   * master wallet with no Ondo API key) cannot block keyless public reads.
   */
  async function createVenueAdapter(venueInput: string, dex: string | null, publicOnly = false): Promise<ExchangeAdapter> {
    const def = getVenue(venueInput);
    if (def.create === null) {
      throw new PerpError("NOT_IMPLEMENTED", `${def.displayName} has no account/trading API`, {
        remediation: `${def.id} is market-data only — use the funding/market public commands (e.g. perp arb scan)`,
      });
    }
    const network = currentNetwork();
    const hlDex = def.id === "hyperliquid" ? dex : null;
    const key = publicOnly ? `${def.id}:${network}:public:${hlDex ?? "-"}` : adapterCacheKey(def.id, network, hlDex);
    const cached = _adapters.get(key);
    if (cached) return cached;

    const cli = cliCredentialOpts();
    const readOnly = publicOnly || !(await hasCredentials(def.id, cli));
    const credentials = readOnly ? READ_ONLY_CREDENTIALS : await resolveCredentials(def.id, cli, network);
    if (!readOnly) warnRestrictedRegions(def);
    const adapter = await def.create({
      network,
      credentials,
      // Commander's `--no-agent` flag sets opts.agent === false (NOT opts.noAgent).
      noAgent: program.opts().agent === false,
      hlDex,
      readOnly,
      // Commander's `--no-builder` sets opts.builder === false.
      noBuilder: program.opts().builder === false,
    });
    _adapters.set(key, adapter);
    registerAdapterNetwork(adapter, network);
    return adapter;
  }

  function getExchange(): VenueId {
    return resolveVenueId(program.opts().exchange as string);
  }

  async function getAdapter(): Promise<ExchangeAdapter> {
    _adapter = await createVenueAdapter(getExchange(), (program.opts().dex as string | undefined) ?? null);
    return _adapter;
  }

  // Sync wrapper for commands that need adapter (lazy init)
  function getAdapterSync(): ExchangeAdapter {
    if (!_adapter) throw new Error("Adapter not initialized");
    return _adapter;
  }

  function isJson(): boolean {
    return !!program.opts().json || process.argv.includes("--ndjson");
  }

  function isDryRunFlag(): boolean {
    return isDryRun(program);
  }

  // Helper to get PacificaAdapter specifically (for Pacifica-only commands) — served from the adapter cache.
  function getPacificaAdapter(): PacificaAdapter {
    const a = _adapters.get(adapterCacheKey("pacifica", currentNetwork(), null));
    if (!(a instanceof PacificaAdapter)) throw new Error("This command requires --exchange pacifica");
    return a;
  }

  // Public market-data adapters (read-only; no credential resolution).
  async function getPublicAdapter(): Promise<ExchangeAdapter> {
    return createVenueAdapter(getExchange(), (program.opts().dex as string | undefined) ?? null, true);
  }
  async function getPublicAdapterForExchange(rawExchange: string): Promise<ExchangeAdapter> {
    return createVenueAdapter(rawExchange, (program.opts().dex as string | undefined) ?? null, true);
  }

  // Register command groups with async adapter getter
  registerMarketCommands(program, getPublicAdapter, isJson, getPublicAdapterForExchange, getAdapter);
  registerAccountCommands(program, getAdapter, isJson, getAdapterForExchange);
  registerOutcomeCommands(program, getAdapterForExchange, isJson);
  registerTradeCommands(program, getAdapter, isJson, isDryRunFlag, getAdapterForExchange);
  // manage tree wired inside registerWalletCommands below.
  // stream commands removed
  registerArbCommands(program, isJson, getAdapterForExchange);
  registerWalletCommands(program, isJson, getAdapter, getPacificaAdapter, getAdapterForExchange);
  registerFundsCommands(
    program,
    getAdapter,
    isJson,
    () => networkOf(program),
    getAdapterForExchange
  );
  // alert commands removed

  // Helper to get adapter for a specific exchange (used by arb-auto)
  async function getAdapterForExchange(rawExchange: string): Promise<ExchangeAdapter> {
    return createVenueAdapter(rawExchange, (program.opts().dex as string | undefined) ?? null);
  }

  // Helper to get an HL adapter configured for a specific HIP-3 dex ("hl" = core perps)
  async function getHLAdapterForDex(dex: string): Promise<HyperliquidAdapter> {
    const adapter = await createVenueAdapter("hyperliquid", dex === "hl" ? null : dex);
    if (!(adapter instanceof HyperliquidAdapter)) throw new Error("hyperliquid venue did not produce a HyperliquidAdapter");
    return adapter;
  }

  registerArbAutoCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
  registerArbManageCommands(program, getAdapterForExchange, isJson);
  // `agent` is no longer top-level — registered as `wallet agent` inside
  // registerWalletCommands above.
  // withdraw merged into funds.
  // `rebalance` is no longer top-level — registered as `funds rebalance` inside
  // registerFundsCommands above.

  // Background processes & strategies
  registerBackgroundCommands(program, isJson, getAdapterForExchange);
  registerStrategyCommands(program, getAdapter, getAdapterForExchange, isJson);

  // Agent-friendly commands
  registerRiskCommands(program, getAdapterForExchange, isJson);
  registerHistoryCommands(program, isJson, getAdapterForExchange);
  registerSettingsCommands(program, isJson, getAdapterForExchange);
  // dex commands removed — use 'market hip3' + --dex flag
  // `plan` is no longer top-level — registered as `strategy plan` inside
  // registerStrategyCommands above.
  // funding merged into arb — registerFundingCommands removed
  registerBacktestCommands(program, isJson);
  registerPortfolioCommand(program, getAdapterForExchange, isJson, version, getHLAdapterForDex);
  registerInitCommand(program);
  registerAlertCommands(program, isJson);

  // Switch shared API URLs if --network testnet is used

  // Validates -n and enforces default-deny --dry-run before any action runs.
  installDryRunGuard(program);
  // Secrets on argv (review L10): -k is rejected outright; --passphrase still works but warns loudly.
  program.hook("preAction", () => assertNoArgvSecrets(program));
  // Switch shared API URLs if --network testnet is used
  program.hook("preAction", () => {
    if (networkOf(program) === "testnet") setSharedApiNetwork("testnet");
  });

  return { program, getAdapterForExchange, isJson };
}
