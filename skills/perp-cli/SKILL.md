---
name: perp-cli
description: "Multi-DEX perpetual futures trading via the perp-cli command-line tool. Use when user asks to: trade perps, check funding rates, scan/execute arbitrage (perp-perp or spot-perp), run delta-neutral strategies, bridge USDC across chains, manage positions/orders/leverage, deposit/withdraw, hedge spot+perp, trade HIP-3 DEXes, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, Lighter, Aster, Lighter RH, Ondo Perps, Arcus, HyperEVM, funding arb, or U-tokens (UBTC/UETH/USOL). Covers Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum), Aster (BNB Chain), Lighter RH and Arcus (Robinhood chain) and Ondo Perps (off-chain)."
license: MIT
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
compatibility: "Requires Node.js 20 or newer and the perp-cli npm package (global install or npx). Network access required for exchange APIs and bridge providers. Mutating commands need a wallet key imported into the OWS vault via 'perp wallet set EXCHANGE' (key on stdin or hidden prompt — never argv). Skill is portable across Claude Code, Claude.ai, Cursor, Codex, and Gemini CLI — no platform-specific features."
metadata:
  author: hypurrquant
  version: "0.13.0"
---

# perp-cli

Multi-DEX perpetual futures CLI + MCP server for Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum), Aster (BNB Chain), Lighter RH (`lighter-rh`, Robinhood chain, USDG), Ondo Perps (`ondo`), QFEX (`qfex`, custodial TradFi perps — import-only API key; reduce-only / close / stop / TP-SL / edit are refused for now, see "QFEX" below), Arcus (`arcus`, Robinhood chain, USDG). v0.13.0+ also supports Hyperliquid Outcome markets (HIP-4) — fully-collateralized binary/range contracts quoted in USDH.

## Instructions

### When to use this skill

Activate whenever the user wants to do anything against perp-cli, including: scanning funding-rate arbitrage, executing perp-perp or spot+perp legs, running long-running strategy bots, moving USDC between chains/exchanges, checking account/portfolio state, configuring wallets, or troubleshooting any of the above.

**Do NOT** answer trading questions from memory — always run the actual CLI command and parse its JSON output.

### Reference files (load only when needed)

This skill uses progressive disclosure. Read these on demand:

- `references/commands.md` — full command tree for every group (market, account, trade, outcome, arb, funds, wallet, risk, history, strategy, background, alerts, settings, backtest)
- `references/agent-operations.md` — non-interactive setup flows, idempotency rules, error codes, common mistakes
- `references/strategies.md` — funding-arb decision framework + risk-management playbook (read before designing arb strategy)

Also bundled under `scripts/`: `preflight.sh`, `arb-monitor.sh`, `funding-analysis.sh`, `spot-perp-scan.sh`, `validate-arb.sh`. Use these for repeatable multi-step diagnostics.

### Critical rules

1. **Always pass `--json`.** Without it, output is human-formatted and hard to parse.
2. **Always run `--dry-run` first** for any mutating trade (open / close / bridge / withdraw). Show the result, get user confirmation, then execute without `--dry-run`.
3. **Always use `--fields`** when you only need specific data — saves tokens.
4. **Avoid bare `perp setup` / `perp init` / `perp wallet setup`** — they prompt and will hang an agent. Use `printf '%s' "$KEY" | OWS_PASSPHRASE=<pp> perp --json wallet set <exchange>` for key registration (key on stdin; a key on argv is rejected), or `perp --json setup --non-interactive --wallet <ows-wallet> --venues <list> [--default-venue <v>] [--slippage-bps <n>] [--slippage <venue>=<bps>]` (new wallet: `--wallet-name <name> --passphrase <pp>`; agent registration only with `--approve-agents --yes`, after user confirmation) (and `OWS_PASSPHRASE=<pp> perp wallet setup --name <n> --max-tx-usd <usd> --max-daily-usd <usd>`) when the wizard is required.
5. **NEVER trade without explicit user confirmation.** A dry-run is not consent.
6. **NEVER read `~/.perp/.env` or other key files.** The CLI reads them — you should not.
7. **NEVER manually add `-PERP` suffix** to symbols. Use bare names (`BTC`, `SOL`, `ICP`); the CLI resolves exchange-specific naming.

### Step 1: Verify install + version

```bash
perp --version 2>/dev/null  # must be >= 0.13.0
npm install -g perp-cli@latest 2>/dev/null || npx -y perp-cli@latest --json --version
```

If `perp` is not on PATH, prefix every command with `npx -y perp-cli@latest`.

### Step 2: Verify wallet + balance

```bash
perp --json wallet show               # confirms configured exchanges
perp --json portfolio -e <ex>         # per-exchange USDC available (account balance was renamed to portfolio in v0.12)
```

If any required exchange is missing, register it (user supplies the key):

```bash
printf '%s' "$EVM_HEX_KEY" | OWS_PASSPHRASE=<pp> perp --json wallet set hl          # Hyperliquid / Lighter / Aster (EVM)
printf '%s' "$SOLANA_BASE58_KEY" | OWS_PASSPHRASE=<pp> perp --json wallet set pac   # Pacifica (Solana)
```

The key is read from stdin (never argv — an argv key is rejected) and imported into the OWS vault; the imported wallet becomes `owsActiveWallet`, which serves every venue. The same EVM key works for Hyperliquid, Lighter and Aster. Lighter trading additionally needs `perp wallet agent approve lighter`.

Lighter RH / Ondo Perps / Arcus have no `wallet set` path — register an agent / API key (user runs it; Ondo reads key id + secret from stdin):

```bash
perp --json wallet agent approve lighter-rh
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp --json wallet agent approve ondo
perp --json wallet agent approve arcus --master <ows-wallet>   # address must be on the Arcus access whitelist
```

**No master wallet on this computer?** The user can create the agent / API key on the exchange website and import it — key on stdin only, verified against the venue before it is stored (`verification.status` is `"unverified"` only for Pacifica, which lists bindings master-signed only):

```bash
printf '%s' "$AGENT_KEY" | perp --json wallet agent import hyperliquid               # master read from HL
printf '%s' "$AGENT_KEY" | perp --json wallet agent import aster --master-address 0x…  # also Aster testnet
printf '%s' "$AGENT_KEY" | perp --json wallet agent import pacifica --master-address <SOL>
printf '%s' "$API_KEY" | perp --json wallet agent import lighter --account-index <n> --api-key-index <slot>
printf '%s' "$ED25519_KEY" | perp --json wallet agent import arcus --master-address 0x…
```

Imported keys trade; `funds deposit|withdraw|transfer|bridge`, `wallet manage referral set` and `wallet agent approve` need the master → `NO_SIGNER_AVAILABLE` (tell the user to do it on the website or `perp wallet import` the master). `wallet agent revoke` of an imported key needs `--local-only` and does NOT revoke it on the exchange; `rotate` is refused (new key on the website → `import --replace`).

**QFEX** (`-e qfex`, testnet = QFEX UAT): keys are created on the QFEX website and imported by the USER (`perp wallet agent import qfex [--account-id <uuid>]` — the resolved account UUID must be confirmed). Rules an agent must follow:
- Refused with `CAPABILITY_UNSUPPORTED` (do not work around): any reduce-only order (`trade close/close-all/flatten/reduce/stop/tpsl`, `--tp/--sl`, MCP `trade_close`), `trade edit`, `--client-id`, non-USD-quoted markets, QFEX as a funding-arb / funding-bot leg. To flatten, tell the user to place a plain opposite order or use the QFEX web app.
- Limit GTC / ALO returns `status: accepted, finality: pending` after the ACK; `open` only via `perp --json trade status c:<id> --symbol <S> -e qfex`.
- `ORDER_PENDING` = outcome unknown: NEVER resubmit; check with the `c:<id>` in the remediation.
- Funding rates on QFEX are unverified: excluded everywhere unless `perp --json arb scan --rates --include-unverified` (display only).
- Withdrawals need `settings.withdraw.qfex` (allowlist + limits), which only the user can set in an interactive terminal — an agent cannot set or change it. `perp --json --dry-run funds withdraw qfex <amt> --to <addr>` shows the gate verdict.

Venue rules for these: `trade limit` on `ondo` / `arcus` has **no default `--tif`** (pass one: ondo GTC|IOC|ALO, arcus GTT|IOC|FOK|ALO); market orders on every venue are bounded by `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (shipped default 50). Ondo (US, PA) and Arcus (US, CA, GB) print a one-time restricted-region notice on stderr when used with credentials (warn only, never blocks).

### Step 3: Discover (read-only)

```bash
perp --json arb scan                              # all modes (perp-perp + spot-perp), default --min 10 (% annual)
perp --json arb scan --mode perp-perp --top 10
perp --json arb scan --mode spot-perp --top 10
perp --json arb scan --rates                      # raw funding rates
perp --json arb scan --basis [<symbol>]           # cross-exchange basis
perp --json arb scan --gaps                       # cross-exchange price gaps
perp --json arb scan --hip3                       # HIP-3 cross-dex spreads
perp --json arb scan --history <symbol>           # historical funding
perp --json arb scan --compare <symbol>           # one symbol across all exchanges
perp --json arb scan --positions                  # funding impact on open positions
perp --json arb scan --live --interval 60         # continuous monitoring
```

Common knobs: `--min <pct>`, `--top <n>`, `--hold-days <n>`, `--bridge-cost <usd>`, `--size <usd>`.

### Step 4: Validate before mutating

For arb:

```bash
perp --json portfolio -e <longEx>                     # check available USDC (long leg)
perp --json portfolio -e <shortEx>                    # check available USDC (short leg)
perp --json --dry-run arb exec <SYM> <longEx> <shortEx> <USD>
```

For a single trade:

```bash
perp --json -e <ex> trade check <SYM> <SIDE> <SIZE> --leverage <N>
perp --json --dry-run -e <ex> trade buy <SYM> <SIZE> --smart
```

> `trade check` does NOT read exchange-set leverage. Always pass `--leverage` explicitly.

Show the dry-run output to the user. Wait for confirmation.

### Step 5: Execute

After explicit user confirmation:

```bash
# Perp-perp arb (auto-matches both legs)
perp --json arb exec <SYM> <longEx> <shortEx> <USD> --smart --reconcile

# Spot+perp arb (spot has 0 funding cost; spot exchanges: hl, lt)
perp --json arb exec <SYM> spot:hl hl <USD>
perp --json arb exec <SYM> spot:lt pac <USD>

# Single trade
perp --json -e <ex> trade buy  <SYM> <SIZE> --smart
perp --json -e <ex> trade sell <SYM> <SIZE> --smart
perp --json -e <ex> trade split <SYM> buy <USD> --max-slippage 0.5
```

HL spot uses U-tokens (`BTC→UBTC`, `ETH→UETH`, `SOL→USOL`) — auto-resolved.

### Step 6: Monitor

```bash
perp --json arb status                              # open arb positions, PnL, funding earned
perp --json portfolio                               # cross-exchange equity + risk
perp --json risk status                             # canTrade, level, violations
perp --json risk liquidation-distance               # % from liq for ALL positions
```

If `risk status.canTrade === false`, do NOT open new positions. If liquidation distance falls below the user's `--min-liq-distance`, recommend reducing position size.

For continuous monitoring, run `bash scripts/arb-monitor.sh --json`.

### Step 7: Close

```bash
perp --json arb close <SYM>                                     # perp-perp arb
perp --json arb close <SYM> --pair <longEx>:<shortEx>           # disambiguate
perp --json arb close <SYM> --spot-exch hl --perp-exch hl       # spot+perp
perp --json arb close <SYM> --smart                             # IOC limits

# Single trade
perp --json -e <ex> trade close <SYM>                           # close one symbol
perp --json -e <ex> trade close-all                             # close all positions on this exchange
perp --json -e <ex> trade flatten                               # close ALL + cancel ALL orders
```

### Funds workflow (deposit / withdraw / transfer / bridge / rebalance)

All money movement lives under `perp funds`:

```bash
# Exchange in/out
perp --json funds deposit hyperliquid 100
perp --json funds deposit pacifica 100
perp --json funds deposit lighter ethereum 100              # L1 direct
perp --json funds deposit lighter cctp arbitrum 100         # via CCTP
perp --json funds withdraw hyperliquid 100
perp --json funds transfer 100 <ADDRESS>                    # HL internal (instant)

# Cross-chain bridge (auto-cheapest cctp/relay/debridge)
perp --json funds bridge quote --from solana --to arbitrum --amount 100
perp --json funds bridge send  --from solana --to arbitrum --amount 100
perp --json funds bridge status <orderId>                   # poll until success

# Inter-exchange rebalance (orchestrated withdraw → bridge → deposit)
perp --json funds rebalance check
perp --json funds rebalance plan
perp --json funds rebalance execute --auto-bridge
```

Always run `funds bridge quote` before `funds bridge send` so the user sees fees + ETA.

Relay swaps between assets (`--from-asset` / `--to-asset`, chains `robinhood`, `arbitrum`, `bsc`, `base`, destination `solana`): run `perp --json --dry-run funds bridge send ...` first — it prints the locally verified quote (amount in, expected out, protocol-guaranteed minimum, fees, ETA) and the min-out verdict without loading a key. Stable → native (e.g. USDG → SOL / ETH) needs `--min-out`. The recipient is always the master wallet's own address; an `ORDER_PENDING` result carries the Relay request id — never bridge again before checking it.

### Strategy engine (20 algorithms + scripted plans)

```bash
perp strategy list-strategies                                 # 20 registered
perp strategy run <strategy> [symbol]                         # run any strategy
perp strategy apex [symbol]                                   # APEX orchestrator
perp strategy reflect                                         # performance analysis
perp --json strategy plan validate <FILE>                     # validate scripted plan
perp --json strategy plan execute <FILE> --dry-run            # dry-run scripted plan
```

**Strategies:** `grid`, `dca`, `simple-mm`, `engine-mm`, `avellaneda-mm`, `regime-mm`, `grid-mm`, `liquidation-mm`, `momentum-breakout`, `mean-reversion`, `aggressive-taker`, `funding-arb`, `funding-arb-v2`, `funding-auto`, `basis-arb`, `spot-perp-arb`, `hedge-agent`, `rfq-agent`, `claude-agent`, `apex`.

Background daemon (tmux):

```bash
perp --json arb auto --min-spread 30 --size 100 --background
perp --json background list
perp --json background logs <id> -f
perp --json background stop <id>
```

Background jobs inherit the parent's `-n`, `--dry-run`, `-e`, `--ows`, `-w`, `--no-agent`, `--dex`, and never receive key material (argv/env): they resolve credentials from the OWS vault / agent keystores / `~/.perp/.env` themselves. `--background` with `-k`, `--passphrase`, `--ows-key` or a shell-exported key / `OWS_PASSPHRASE` → `INVALID_PARAMS` — register an agent (`perp wallet agent approve <venue>`), which signs without the master passphrase.

### Position sizing & safety

- Single position notional < **80%** of that exchange's available balance.
- Leverage 1–3x for arb; never above 5x for arb positions.
- `arb exec` auto-matches both legs to the same size; pass `--reconcile` to trim mismatches.
- ALWAYS follow `longExch`/`shortExch` from `arb scan` — NEVER reverse direction.
- NEVER enter if `netSpread <= 0` or `netSpread < estimated round-trip slippage`.
- Capital that's mid-bridge is "at risk" and unhedged — factor it in.

For deeper risk-management framework, read `references/strategies.md`.

## Examples

### Example 1: "Find funding-rate arb opportunities"

```bash
# 1. Discover
perp --json arb scan --min 10 --top 10
# 2. Show top 3 to user; ask which to evaluate
# 3. Check balances on the two exchanges
perp --json portfolio -e <longEx>
perp --json portfolio -e <shortEx>
# 4. Recommend size + dry-run
perp --json --dry-run arb exec BTC <longEx> <shortEx> 100
# 5. After user confirmation:
perp --json arb exec BTC <longEx> <shortEx> 100 --smart
perp --json arb status
```

### Example 2: "ETH spot+perp arb, $100"

```bash
perp --json --dry-run arb exec ETH spot:hl hl 100
# → show dry-run, ask confirmation
perp --json arb exec ETH spot:hl hl 100
perp --json arb status
# Later, to close both legs:
perp --json arb close ETH --spot-exch hl --perp-exch hl
```

### Example 3: "Long SOL 0.5 on Hyperliquid with 2x leverage"

```bash
perp --json -e hl wallet manage margin SOL isolated   # use isolated margin for new trade
perp --json -e hl trade leverage SOL 2 --isolated
perp --json -e hl trade check SOL buy 0.5 --leverage 2
perp --json --dry-run -e hl trade buy SOL 0.5 --smart
# → show dry-run, ask confirmation
perp --json -e hl trade buy SOL 0.5 --smart
perp --json -e hl account positions
```

### Example 4: "Move 500 USDC from Pacifica to Hyperliquid"

```bash
perp --json funds withdraw pacifica 500
perp --json funds bridge quote --from solana --to arbitrum --amount 500
# → show fee, ETA, ask confirmation
perp --json funds bridge send  --from solana --to arbitrum --amount 500
perp --json funds bridge status <orderId>             # poll until completed
perp --json funds deposit hyperliquid 500
```

Or use the orchestrated path:

```bash
perp --json funds rebalance plan
perp --json funds rebalance execute --auto-bridge
```

### Example 5: "Run a delta-neutral funding bot in background"

```bash
perp --json arb auto --min-spread 30 --close-spread 5 --size 100 --max-positions 5 --background
perp --json background list
perp --json background logs <id> -f
# To stop:
perp --json background stop <id>
```

## Troubleshooting

Every response is `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": "...", "retryable": true|false } }`. Always check `ok` first.

| Error code | Meaning | Action |
|---|---|---|
| `RATE_LIMITED` | Exchange throttled the request | Wait 5s, retry up to 3 times. For Lighter, space calls 3s+ apart. |
| `EXCHANGE_UNREACHABLE` | API down or network issue | Wait 10s, retry. After 3 failures, skip that exchange and continue. |
| `INSUFFICIENT_BALANCE` | Not enough USDC on that exchange | Reduce size or `funds bridge`/`funds rebalance` first. |
| `SYMBOL_NOT_FOUND` | Symbol not listed on this exchange | Run `market list` to verify. Don't add `-PERP` suffix manually. |
| `SIZE_TOO_SMALL` | Below exchange minimum (HL is $10 notional) | Compute `size × price` before submitting; raise size. |
| `DUPLICATE_ORDER` | Same `--client-id` already submitted | Already executed — check `account positions` instead of retrying. |
| `INVALID_SIGNATURE` (Lighter) | API key drift / not approved | `perp wallet agent approve lighter --master <wallet>` to regenerate. |

### Common mistakes

- **Forgetting `--json`** → output becomes unparseable human text. The very first thing to check when parsing fails.
- **Using legacy command names** — `arb rates`/`arb prices`/`arb dex`/`arb spot-exec`/`arb spot-close` are removed. Use `arb scan --rates|--gaps|--hip3` and `arb exec spot:<exch>` / `arb close <SYM> --spot-exch <ex>`.
- **Calling `trade check` without `--leverage`** → cost estimate doesn't match what the exchange applies.
- **Retrying a non-idempotent trade** without checking `account positions` → opens a duplicate position.
- **Bridging without quoting first** → user sees no fee/ETA and can't approve cleanly.
- **Treating `bridge send` as instant** → always `funds bridge status <orderId>` before depositing on the destination.
- **Manually adding `-PERP` suffix** → CLI auto-resolves; let it.

For a full troubleshooting + non-interactive flow guide, read `references/agent-operations.md`.

## Referrals (optional, ask once per setup)

```bash
perp --json --dry-run -e hyperliquid wallet manage referral set   # preview (nothing signed)
perp --json -e hyperliquid wallet manage referral set [code]      # signs + sends ONE referral action
perp --json -e lighter wallet manage referral set [code]          # Lighter (needs an agent key)
```

Referral codes are never applied implicitly (adapter creation signs nothing). When the user first sets up a wallet, ask:
> "perp-cli development is supported by optional referrals. Apply the referral code? It signs one referral action on the venue; no extra fees — only exchange rebates are used."

## Builder fees (OFF by default — never enable on your own)

Builder fees are extra fees on the USER's perp orders, paid to a third-party builder. perp-cli attaches none unless the user explicitly set `settings builder.<venue>` AND the venue approval is confirmed. Do not configure or approve a builder unless the user asks for it.

```bash
perp --json wallet builder status [venue]                 # support, config, approval, attaches?
perp --json --dry-run wallet builder approve <venue>      # plan only — show it to the user
perp --json wallet builder approve <venue> --yes          # only after explicit user consent (master-signed)
perp --json --no-builder trade market BTC buy 0.1         # one run without the fee
```

qfex: `builder.qfex <uuid>` is a fee share (no extra fee, no approval; mainnet only). Unsupported: lighter, lighter-rh, arcus (`CAPABILITY_UNSUPPORTED`). An order whose approval is missing or unknown is sent without the fee (`execution.notes`); `execution.builderFee` records what was attached.

## MCP Server

The package also ships a 22-tool MCP server (no API keys required for read-only market data — `get_markets`, `get_orderbook`, `get_funding_rates`, `get_prices`, `get_outcome_markets`, `get_outcome_view`, `get_outcome_book`, plus 15 account/advisor tools):

MCP network: `PERP_NETWORK=mainnet|testnet` (validated; unset = mainnet); every result's `meta.network` says which. The only write tools, `trade_execute` / `trade_close`, run the same local risk gate as `perp trade` (no override over MCP), refuse non-reduce-only orders on quarantined symbols, and log every order.

```json
{
  "mcpServers": {
    "perp-cli": {
      "command": "npx",
      "args": ["-y", "-p", "perp-cli", "perp-mcp"]
    }
  }
}
```

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)
