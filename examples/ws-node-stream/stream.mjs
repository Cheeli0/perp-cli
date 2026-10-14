#!/usr/bin/env node
// perp-cli/ws in Node: market state + bbo for one symbol, and (optionally) your own account stream.
//
//   node examples/ws-node-stream/stream.mjs [venue] [symbol] [--seconds N] [--user]
//
// --user subscribes account/positions/orders/fills through the CLI's credential provider (reads the
// active OWS wallet / registered agents from ~/.perp; never argv/env; never prompts). It is part of
// the CLI build (dist/ws-cli), not of the published perp-cli/ws API — pass your own CredentialProvider
// in an app. Output: one compact line per event. Read-only: nothing here places or changes orders.
import { arcus, aster, createVenueStream, hyperliquid, lighter, lighterRh, pacifica, toApr } from "perp-cli/ws/node";

const CODECS = { hyperliquid, pacifica, lighter, "lighter-rh": lighterRh, aster, arcus };
const DEFAULT_SYMBOL = { hyperliquid: "BTC", pacifica: "BTC", lighter: "BTC", "lighter-rh": "BTC", aster: "BTCUSDT", arcus: "BTC-USD" };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--seconds"));
const venue = positional[0] ?? "hyperliquid";
const codec = CODECS[venue];
if (codec === undefined) { console.error(`unknown venue ${venue}; one of ${Object.keys(CODECS).join(", ")}`); process.exit(2); }
const symbol = positional[1] ?? DEFAULT_SYMBOL[venue];
const seconds = Number(opt("--seconds", "20"));

let credentials;
if (flag("--user")) {
  const { createCliCredentialProvider } = await import("../../dist/ws-cli/credentials.js"); // `pnpm build` first
  credentials = createCliCredentialProvider(venue, "mainnet");
}

const stream = createVenueStream(codec, { credentials, logger: (l) => { if (l.level !== "info") console.error(`[${l.level}] ${l.event}: ${l.message}`); } });
stream.onState((s) => console.log(`state ${s.status}${s.status === "reconnecting" ? ` in ${s.inMs} ms: ${s.reason.message}` : ""}`));

const counts = {};
const print = (e) => {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  switch (e.type) {
    case "market": {
      const f = e.funding;
      if (counts.market <= 3 || counts.market % 10 === 0) {
        console.log(`market ${e.symbol} mark ${e.mark} index ${e.index} funding ${f.rate} (${f.rateKind}, ${f.rateIntervalHours} h, APR ${toApr(f.rate, f.rateIntervalHours)?.toFixed(4) ?? "null"}) predicted ${f.predictedRate} OI ${e.openInterest.value} ${e.openInterest.unit ?? ""}`);
      }
      break;
    }
    case "bbo":
      if (counts.bbo <= 3 || counts.bbo % 50 === 0) console.log(`bbo ${e.symbol} ${e.bid} x ${e.bidSize} / ${e.ask} x ${e.askSize}`);
      break;
    case "account": console.log(`account${e.dex ? ` [${e.dex}]` : ""} equity ${e.equity} available ${e.available}`); break;
    case "positions": console.log(`positions ${e.positions.length} (snapshot ${e.snapshot})`); break;
    case "orders": console.log(`orders ${e.orders.length} (complete ${e.complete})`); break;
    case "fills": console.log(`fills snapshot: ${e.fills.length}`); break;
    case "fill": console.log(`fill ${e.fill.symbol} ${e.fill.side} ${e.fill.size} @ ${e.fill.price}`); break;
    case "gap": console.log(`gap ${e.channel} → ${e.action} (refetch over REST)`); break;
    case "error": console.log(`error ${e.code}${e.fatal ? " (fatal)" : ""}: ${e.message}${e.remediation ? ` — ${e.remediation}` : ""}`); break;
    default: break;
  }
};

const subs = [stream.subscribe({ kind: "market", symbol, channels: ["market", "bbo"] })];
if (credentials !== undefined) subs.push(stream.subscribe({ kind: "user", channels: ["account", "positions", "orders", "fills"] }));
for (const s of subs) {
  s.on(print);
  s.ready.catch((e) => console.log(`subscription rejected: ${e.structured?.code} ${e.message}`));
}

await new Promise((r) => setTimeout(r, seconds * 1000));
await stream.close();
console.log(`done after ${seconds}s: ${JSON.stringify(counts)}`);
const ok = (counts.market ?? 0) > 0;
process.exit(ok ? 0 : 1);
