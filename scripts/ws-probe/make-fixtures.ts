/**
 * Phase 0: turn raw probe captures (probe.ts --out <dir>) into committed WS fixtures under
 * src/__tests__/fixtures/ws/<venue>/*.json.
 *
 *   pnpm tsx scripts/ws-probe/make-fixtures.ts --raw <dir>
 *
 * Public frames are trimmed for size. Private frames are anonymized (plan §3 M8):
 *   - the `main` wallet's addresses / account ids → fixed per-venue dummies, any other address → a second dummy;
 *   - order / trade / client ids and hashes → stable remapped dummies (equality between frames preserved);
 *   - amounts (decimal strings and numbers that are not ids, timestamps or sequence numbers) → × PERTURB;
 *   - timestamps → shifted by a fixed offset (unit-aware: s / ms / µs / ns);
 *   - auth / token / listenKey / signature / hmac fields → removed.
 * Before writing a file it re-checks that no real id, original hash or original order/trade id is present
 * and aborts otherwise. The real ids are resolved at run time (ids.ts) — never written anywhere.
 * Not part of the CLI build.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRealIds, type RealIds } from "./ids.js";

export const DUMMY = {
  evm: "0x000000000000000000000000000000000000dEaD",
  evmOther: "0x000000000000000000000000000000000000bEEF",
  solana: "DummyPacificaAccount111111111111111111111111",
  lighterAccountIndex: 1000001,
  lighterRhAccountIndex: 1000002,
} as const;
const PERTURB = 1.0731;
const SHIFT_S = 864_000 + 1234; // ~10 days

const REPO = resolve(import.meta.dirname, "../..");
const FIX = resolve(REPO, "src/__tests__/fixtures/ws");
const args = process.argv.slice(2);
const rawIdx = args.indexOf("--raw");
const RAW = rawIdx >= 0 ? resolve(args[rawIdx + 1] ?? "") : "";
if (!RAW) throw new Error("--raw <dir> is required");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Row { t: number; at: number; dir: "in" | "out" | "event"; data: Json }

function load(file: string): Row[] {
  return readFileSync(resolve(RAW, file), "utf8").trim().split("\n").map(l => JSON.parse(l) as Row);
}
const inbound = (rows: Row[]) => rows.filter(r => r.dir === "in");
const obj = (j: Json): { [k: string]: Json } => (j !== null && typeof j === "object" && !Array.isArray(j) ? j : {});

// ── anonymizer ──
const SECRET_KEY = /^(auth|token|authToken|listenKey|signature|sig|hmac|apiKey|secret)$/i;
const ID_KEY = /^(oid|tid|orderId|tradeId|order_id|trade_id|i|li|clientId|client_id|client_order_id|cloid|hash|tx_hash|txHash|twapId|connection_id|session_id)$/;
const TS_KEY = /(^t$|^T$|^E$|time|Time|timestamp|Timestamp|_at$|At$|epoch|Epoch|goodTil)/;
const KEEP_KEY = /(market|Market|asset|coin|symbol|^s$|side|dir|status|type|Type|mode|sign|count|Count|slot|leverage|Leverage|marginFraction|sequence|Sequence|lastSequenceId|accountIndex|account_index|feeToken|positionEffect|role|timeInForce|reduceOnly|crossed|channel|source|isSnapshot|dex|liquidationFeePpm)/;

class Anon {
  private ids = new Map<string, string | number>();
  readonly originals = new Set<string>();
  constructor(private real: RealIds) {}

  private realLighter(n: number): number | null {
    if (n === this.real.lighterAccountIndex) return DUMMY.lighterAccountIndex;
    if (n === this.real.lighterRhAccountIndex) return DUMMY.lighterRhAccountIndex;
    return null;
  }
  str(s: string): string {
    let out = s.replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, m => {
      const own = [this.real.evm, this.real.arcusOwner].some(a => a !== null && a.toLowerCase() === m.toLowerCase());
      return own ? DUMMY.evm : DUMMY.evmOther;
    });
    out = out.split(this.real.solana).join(DUMMY.solana);
    for (const [r, d] of [[this.real.lighterAccountIndex, DUMMY.lighterAccountIndex], [this.real.lighterRhAccountIndex, DUMMY.lighterRhAccountIndex]] as const) {
      if (r !== null) out = out.replace(new RegExp(`(?<![0-9])${r}(?![0-9])`, "g"), String(d));
    }
    return out;
  }
  private remap(v: string | number): string | number {
    const key = `${typeof v}:${v}`;
    const hit = this.ids.get(key);
    if (hit !== undefined) return hit;
    this.originals.add(String(v));
    const k = this.ids.size + 1;
    let out: string | number;
    if (typeof v === "number") out = 900_000 + k;
    else if (/^0x[0-9a-fA-F]{64}$/.test(v)) out = "0x" + "d0".repeat(28) + k.toString(16).padStart(8, "0");
    else if (/^[0-9]+$/.test(v)) out = String(900_000 + k);
    else out = `dummy-id-${k}`;
    this.ids.set(key, out);
    return out;
  }
  private shiftTs(n: number): number {
    if (n > 1e17) return n - SHIFT_S * 1e9;
    if (n > 1e14) return n - SHIFT_S * 1e6;
    if (n > 1e11) return n - SHIFT_S * 1e3;
    if (n > 1e9) return n - SHIFT_S;
    return n;
  }
  private perturb(v: string | number): string | number {
    if (typeof v === "number") return Number.isInteger(v) ? Math.round(v * PERTURB) : Number((v * PERTURB).toPrecision(10));
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
    if (!m) return v;
    const dp = (m[3] ?? "").length;
    const x = Number(v) * PERTURB;
    const same = x.toFixed(dp);
    // Too few decimals to move the value (e.g. "0.005") → add precision so it still differs from the real one.
    return same === v && Number(v) !== 0 ? x.toFixed(dp + 2) : same;
  }
  walk(j: Json, key = ""): Json | undefined {
    if (SECRET_KEY.test(key)) return undefined;
    if (Array.isArray(j)) return j.map(x => this.walk(x, key)).filter((x): x is Json => x !== undefined);
    if (j !== null && typeof j === "object") {
      const o: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(j)) {
        const w = this.walk(v, k);
        if (w !== undefined) o[this.str(k)] = w;
      }
      return o;
    }
    if (typeof j === "number") {
      const rl = this.realLighter(j);
      if (rl !== null) return rl;
      if (ID_KEY.test(key)) return this.remap(j);
      if (TS_KEY.test(key)) return this.shiftTs(j);
      if (KEEP_KEY.test(key)) return j;
      return this.perturb(j);
    }
    if (typeof j === "string") {
      const s = this.str(j);
      if (s !== j) return s;
      if (ID_KEY.test(key) && j !== "") return this.remap(j);
      if (TS_KEY.test(key) && /^\d+$/.test(j)) return String(this.shiftTs(Number(j)));
      if (KEEP_KEY.test(key)) return j;
      return this.perturb(j);
    }
    return j;
  }
}

// ── writer with the real-id guard ──
function guard(text: string, real: RealIds, anon: Anon | null, file: string): void {
  const lower = text.toLowerCase();
  const bad: string[] = [];
  for (const a of [real.evm, real.arcusOwner]) if (a && lower.includes(a.toLowerCase())) bad.push("evm address");
  if (text.includes(real.solana)) bad.push("solana address");
  for (const n of [real.lighterAccountIndex, real.lighterRhAccountIndex]) {
    if (n !== null && new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text)) bad.push("lighter account index");
  }
  if (/"(auth|token|listenKey|signature|hmac)"\s*:/i.test(text)) bad.push("secret field");
  if (anon) for (const o of anon.originals) if (o.length >= 6 && text.includes(o)) bad.push(`original id ${o.slice(0, 4)}…`);
  if (bad.length) throw new Error(`refusing to write ${file}: contains ${[...new Set(bad)].join(", ")}`);
}

interface Fixture { venue: string; channel: string; kind: "public" | "private"; captured: string; note: string; frames: Json[] }
function write(real: RealIds, anon: Anon | null, venue: string, name: string, f: Omit<Fixture, "venue" | "captured">): void {
  const body: Fixture = { venue, captured: "2026-10-13 (live probe, scripts/ws-probe)", ...f };
  const text = JSON.stringify(body, null, 2) + "\n";
  const file = `${venue}/${name}.json`;
  guard(text, real, anon, file);
  mkdirSync(resolve(FIX, venue), { recursive: true });
  writeFileSync(resolve(FIX, file), text);
  console.log(`wrote ${file} (${text.length} B, ${f.frames.length} frames)`);
}

const pick = <T>(xs: T[], n: number): T[] => xs.slice(0, n);
function byChannel(rows: Row[], pred: (d: { [k: string]: Json }) => boolean): Json[] {
  return inbound(rows).map(r => r.data).filter(d => pred(obj(d)));
}
function pickKeys(o: { [k: string]: Json }, keys: string[]): { [k: string]: Json } {
  return Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k] as Json]));
}

function main(): void {
  const real = resolveRealIds();

  // ── hyperliquid public ──
  {
    const rows = load("public-hyperliquid.jsonl");
    const all = byChannel(rows, d => d["channel"] === "allDexsAssetCtxs");
    const trimAll = (f: Json): Json => {
      const d = obj(obj(f)["data"]);
      const ctxs = (d["ctxs"] as Json[]).filter(x => ["", "xyz", "abcd"].includes((x as Json[])[0] as string))
        .map(x => [(x as Json[])[0] as Json, pick((x as Json[])[1] as Json[], 6)]);
      return { channel: "allDexsAssetCtxs", data: { ctxs } };
    };
    write(real, null, "hyperliquid", "allDexsAssetCtxs", {
      channel: "allDexsAssetCtxs", kind: "public",
      note: "ctxs = [[dex, ctx[]]] per dex ('' = native first, then HIP-3 dexes alphabetically). ctx arrays are POSITIONAL (index = meta{dex}.universe index), no coin field. Trimmed to dexes '', xyz, abcd and the first 6 ctxs each (prefix, so indices stay valid). Observed cadence ~11-15 s. midPx/impactPxs/premium can be null.",
      frames: pick(all, 2).map(trimAll),
    });
    write(real, null, "hyperliquid", "activeAssetCtx", {
      channel: "activeAssetCtx", kind: "public",
      note: "Per-coin, ~1 s cadence. HIP-3 coin keyed as '<dex>:<COIN>'.",
      frames: [...pick(byChannel(rows, d => d["channel"] === "activeAssetCtx" && obj(d["data"])["coin"] === "BTC"), 2),
        ...pick(byChannel(rows, d => d["channel"] === "activeAssetCtx" && obj(d["data"])["coin"] === "xyz:XYZ100"), 2)],
    });
    write(real, null, "hyperliquid", "bbo", {
      channel: "bbo", kind: "public",
      note: "Full top-of-book per message: bbo = [bid, ask] each {px, sz, n} (either may be null). `time` ms; no sequence number.",
      frames: [...pick(byChannel(rows, d => d["channel"] === "bbo" && obj(d["data"])["coin"] === "BTC"), 4),
        ...pick(byChannel(rows, d => d["channel"] === "bbo" && obj(d["data"])["coin"] === "xyz:XYZ100"), 2)],
    });
    const err = load("errors.jsonl");
    write(real, null, "hyperliquid", "control", {
      channel: "control", kind: "public",
      note: "subscriptionResponse acks, app pong, and the error frame for an unknown subscription type. An unknown COIN gets no error frame: the server closes the socket (client sees 1006).",
      frames: [...pick(byChannel(rows, d => d["channel"] === "subscriptionResponse"), 2), ...byChannel(rows, d => d["channel"] === "pong"),
        { channel: "error", data: "Error parsing JSON into valid websocket request: {\"method\":\"subscribe\",\"subscription\":{\"type\":\"nopeType\"}}" }],
    });
    void err;
  }

  // ── pacifica public ──
  {
    const rows = load("public-pacifica.jsonl");
    const prices = byChannel(rows, d => d["channel"] === "prices").map(f => ({
      channel: "prices",
      data: (obj(f)["data"] as Json[]).filter(x => ["BTC", "ETH", "FARTCOIN", "TSLA"].includes(obj(x)["symbol"] as string)),
    }));
    write(real, null, "pacifica", "prices", {
      channel: "prices", kind: "public",
      note: "All symbols every ~3 s (trimmed to 4). funding = last settled hourly rate (== REST funding_rate/history latest), next_funding = predicted. open_interest in base units, volume_24h USD.",
      frames: pick(prices, 2),
    });
    write(real, null, "pacifica", "bbo", {
      channel: "bbo", kind: "public",
      note: "Per symbol. `li` (last order id) is strictly increasing across frames but not contiguous — usable for ordering/dedupe only, not gap detection. `i` is not monotonic.",
      frames: pick(byChannel(rows, d => d["channel"] === "bbo"), 5),
    });
    write(real, null, "pacifica", "control", {
      channel: "control", kind: "public",
      note: "subscribe ack (echo of params; also sent for an unknown symbol — no error frame), pong.",
      frames: [...pick(byChannel(rows, d => d["channel"] === "subscribe"), 2), ...byChannel(rows, d => d["channel"] === "pong"),
        { channel: "unsubscribe", data: { source: "bbo", symbol: "BTC" } }],
    });
  }

  // ── lighter + lighter-rh public ──
  for (const venue of ["lighter", "lighter-rh"] as const) {
    const rows = load(`public-${venue}.jsonl`);
    const ms = byChannel(rows, d => d["channel"] === "market_stats:all");
    const keep = venue === "lighter" ? ["0", "1", "158"] : ["0", "1", "4"];
    const trimMs = (f: Json): Json => {
      const o = obj(f);
      return { ...o, market_stats: pickKeys(obj(o["market_stats"]), keep) };
    };
    const updates = ms.filter(f => obj(f)["type"] === "update/market_stats" && keep.some(k => k in obj(obj(f)["market_stats"])));
    write(real, null, venue, "market_stats-all", {
      channel: "market_stats/all", kind: "public",
      note: "First frame 'subscribed/market_stats' = all markets; then 'update/market_stats' ~1 s carrying only changed markets (each entry complete). funding_rate = last settled, current_funding_rate = estimate of the next hourly payment; BOTH in PERCENT per 1 h (== /api/v1/fundings `rate`; REST /api/v1/funding-rates rate = current_funding_rate × 8 / 100). open_interest is USD notional (≈ REST orderBookDetails open_interest × mark), not base as documented. Trimmed to markets " + keep.join(", ") + ".",
      frames: [trimMs(ms[0] as Json), ...pick(updates, 2).map(trimMs)],
    });
    write(real, null, venue, "ticker", {
      channel: "ticker/1", kind: "public",
      note: "nonce strictly increasing but NOT contiguous (ordering only). last_updated_at µs, timestamp ms.",
      frames: pick(byChannel(rows, d => d["channel"] === "ticker:1"), 4),
    });
  }
  {
    const err = load("errors.jsonl");
    const rows = load("public-lighter.jsonl");
    write(real, null, "lighter", "control", {
      channel: "control", kind: "public",
      note: "connected, pong, unsubscribed, and error frames. Errors carry no channel field: {error:{code,message}}. 20001 = auth required (account_all_orders), 30002 = not subscribed, 30005 = invalid channel.",
      frames: [
        ...byChannel(rows, d => d["type"] === "connected").map(f => ({ ...obj(f), session_id: "00000000-0000-0000-0000-000000000000" })),
        ...byChannel(rows, d => d["type"] === "pong"),
        { type: "unsubscribed", channel: `user_stats:${DUMMY.lighterAccountIndex}` },
        { error: { code: 20001, message: `invalid param : auth field is required: account_all_orders:${DUMMY.lighterAccountIndex}` } },
        { error: { code: 30002, message: `Not Subscribed to : account_all_orders:${DUMMY.lighterAccountIndex}` } },
        ...pick(byChannel(err, d => obj(d["error"])["code"] === 30005), 1),
      ],
    });
  }

  // ── aster public ──
  {
    const rows = load("public-aster.jsonl");
    const by = (s: string) => byChannel(rows, d => d["stream"] === s);
    const syms = ["BTCUSDT", "ETHUSDT", "ASTERUSDT", "BTCUSD1"];
    const trimArr = (f: Json): Json => {
      const o = obj(f);
      return { ...o, data: (o["data"] as Json[]).filter(x => syms.includes(obj(x)["s"] as string)) };
    };
    write(real, null, "aster", "markPrice-arr", {
      channel: "!markPrice@arr@1s", kind: "public",
      note: "Combined-stream envelope {stream,data}. All symbols every 1 s (784 incl. non-USDT quotes; trimmed). r = current-period accruing estimate (== premiumIndex.lastFundingRate, != last settled /fapi/v3/fundingRate), T = nextFundingTime ms.",
      frames: pick(by("!markPrice@arr@1s"), 2).map(trimArr),
    });
    write(real, null, "aster", "ticker-arr", {
      channel: "!ticker@arr", kind: "public",
      note: "~1 s, carries only symbols that changed in the window (13 in the first frame). q = quote volume, c = last.",
      frames: pick(by("!ticker@arr"), 2).map(f => ({ ...obj(f), data: pick(obj(f)["data"] as Json[], 3) })),
    });
    write(real, null, "aster", "bookTicker", {
      channel: "btcusdt@bookTicker", kind: "public",
      note: "u (updateId) strictly increasing, not contiguous (ordering only). T transaction ms, E event ms.",
      frames: pick(by("btcusdt@bookTicker"), 4),
    });
    const err = load("errors.jsonl");
    write(real, null, "aster", "control", {
      channel: "control", kind: "public",
      note: "Raw /ws socket: SUBSCRIBE / LIST_SUBSCRIPTIONS / UNSUBSCRIBE results. An unknown stream name is accepted silently (result null, listed, no data).",
      frames: byChannel(err, d => "id" in d && "result" in d),
    });
  }

  // ── arcus public ──
  {
    const rows = load("public-arcus.jsonl");
    const trimMk = (f: Json): Json => {
      const o = obj(f); const c = obj(o["contents"]);
      return { ...o, contents: { ...c, markets: pickKeys(obj(c["markets"]), ["1", "2", "32"]) } };
    };
    write(real, null, "arcus", "markets", {
      channel: "markets", kind: "public",
      note: "First 'subscribed' then 'channel_data' every ~5 s; each a full snapshot of all 67 markets (trimmed to 1, 2, 32). Carries markPrice (no oraclePrices sub needed), fundingRate = last applied (== REST /v1/fundingRates latest), nextFundingRate = predicted, nextFundingAt unix SECONDS, openInterest base (one side), volume24h BASE and volume24hNotional USD.",
      frames: [trimMk(byChannel(rows, d => d["type"] === "subscribed" && d["channel"] === "markets")[0] as Json),
        trimMk(byChannel(rows, d => d["type"] === "channel_data" && d["channel"] === "markets")[0] as Json)],
    });
    write(real, null, "arcus", "bbo", {
      channel: "bbo", kind: "public",
      note: "lastSequenceId / globalSequenceId strictly increasing, not contiguous (ordering only). timestamp µs.",
      frames: [...byChannel(rows, d => d["type"] === "subscribed" && d["channel"] === "bbo"), ...pick(byChannel(rows, d => d["type"] === "channel_data" && d["channel"] === "bbo"), 3)],
    });
    write(real, null, "arcus", "predictedFunding", {
      channel: "predictedFunding", kind: "public",
      note: "Per market; rate1h. Snapshot on subscribe; updates on recompute.",
      frames: byChannel(rows, d => d["channel"] === "predictedFunding"),
    });
    const err = load("errors.jsonl");
    const arcErr = obj(byChannel(err, d => d["type"] === "error")[0] as Json);
    write(real, null, "arcus", "control", {
      channel: "control", kind: "public",
      note: "connected, app pong ({type:ping} → {type:pong}), error frame without channel/id (message truncated here). Server also sends WS-protocol pings every 30 s.",
      frames: [...byChannel(rows, d => d["type"] === "connected").map(f => ({ ...obj(f), connection_id: "1000000000000000000" })),
        ...byChannel(rows, d => d["type"] === "pong"),
        { ...arcErr, message: String(arcErr["message"]).slice(0, 80) + " …]" },
        { type: "unsubscribed", channel: "userFills", id: DUMMY.evm, accountIndex: 0 }],
    });
  }

  // ── private (anonymized) ──
  const anon = new Anon(real);
  const A = (f: Json): Json => anon.walk(f) as Json;
  {
    const rows = load("private/private-hyperliquid.jsonl");
    write(real, anon, "hyperliquid", "private-clearinghouseState", {
      channel: "clearinghouseState", kind: "private",
      note: "Anonymized. Snapshot on subscribe, then re-pushed ~every 5 s even without changes (usable as liveness). One subscription per dex ('' and 'xyz').",
      frames: pick(byChannel(rows, d => d["channel"] === "clearinghouseState"), 2).map(A),
    });
    write(real, anon, "hyperliquid", "private-openOrders", {
      channel: "openOrders", kind: "private",
      note: "Anonymized. Snapshot on subscribe, re-pushed ~5 s.",
      frames: pick(byChannel(rows, d => d["channel"] === "openOrders"), 1).map(A),
    });
    write(real, anon, "hyperliquid", "private-userFills", {
      channel: "userFills", kind: "private",
      note: "Anonymized (ids remapped, amounts ×1.0731, times shifted). isSnapshot:true is re-sent on every (re)subscribe, same conn or new conn (30 fills observed) → replayable, dedupe by tid. Trimmed to 3 fills.",
      frames: byChannel(rows, d => d["channel"] === "userFills").slice(0, 2).map(f => {
        const o = obj(f); const d = obj(o["data"]);
        return A({ ...o, data: { ...d, fills: pick(d["fills"] as Json[], 3) } });
      }),
    });
    write(real, anon, "hyperliquid", "private-control", {
      channel: "control", kind: "private",
      note: "Anonymized subscriptionResponse acks for user channels (server adds dex:'' and aggregateByTime:false).",
      frames: byChannel(rows, d => d["channel"] === "subscriptionResponse").slice(0, 5).map(A),
    });
  }
  {
    const rows = load("private/private-pacifica.jsonl");
    write(real, anon, "pacifica", "private-account", {
      channel: "account_info / account_positions", kind: "private",
      note: "Anonymized. account_positions sends a snapshot array (+li) on subscribe; account_info a snapshot then changes. account_trades / account_order_updates send NO snapshot on (re)subscribe → not replayable.",
      frames: [...byChannel(rows, d => d["channel"] === "subscribe"), ...pick(byChannel(rows, d => d["channel"] === "account_positions"), 1),
        ...pick(byChannel(rows, d => d["channel"] === "account_info"), 1)].map(A),
    });
  }
  for (const venue of ["lighter", "lighter-rh"] as const) {
    const rows = load(`private/private-${venue}.jsonl`);
    const trimPos = (f: Json): Json => {
      const o = obj(f);
      const p = obj(o["positions"]);
      return { ...o, positions: Object.fromEntries(Object.entries(p).slice(0, 2)) };
    };
    write(real, anon, venue, "private-account", {
      channel: "user_stats / account_all_positions / account_all_orders / account_all_trades", kind: "private",
      note: "Anonymized. user_stats, account_all_positions, account_all_trades work WITHOUT auth; account_all_orders needs auth (error 20001 otherwise). account_all_trades 'subscribed/' snapshot carried trades:{} despite non-zero daily_volume → no replay of recent fills. Positions trimmed to 2 markets.",
      frames: [
        ...pick(byChannel(rows, d => d["type"] === "subscribed/user_stats"), 1),
        ...pick(byChannel(rows, d => typeof d["channel"] === "string" && (d["channel"] as string).startsWith("account_all_positions")), 1).map(trimPos),
        ...pick(byChannel(rows, d => d["type"] === "subscribed/account_all_orders"), 1),
        ...pick(byChannel(rows, d => d["type"] === "subscribed/account_all_trades"), 1),
      ].map(A),
    });
  }
  {
    const rows = load("private/private-arcus.jsonl");
    const trimList = (f: Json, field: string, n: number): Json => {
      const o = obj(f); const c = obj(o["contents"]);
      return { ...o, contents: { ...c, [field]: pick((c[field] as Json[]) ?? [], n) } };
    };
    write(real, anon, "arcus", "private-account", {
      channel: "account / positions / orders / userFills", kind: "private",
      note: "Anonymized. No auth: subscribe by address (id), accountIndex defaults to 0. account re-pushed as isSnapshot:true ~5 s. userFills isSnapshot:true re-sent on resubscribe → replayable (dedupe by tradeId). Lists trimmed to 2.",
      frames: [
        ...byChannel(rows, d => d["type"] === "subscribed" && (d["channel"] === "account" || d["channel"] === "positions")),
        ...byChannel(rows, d => d["type"] === "subscribed" && d["channel"] === "orders").map(f => trimList(f, "recentClosedOrders", 2)),
        ...pick(byChannel(rows, d => d["type"] === "subscribed" && d["channel"] === "userFills"), 1).map(f => {
          const o = obj(f); const c = obj(o["contents"]);
          return { ...o, contents: { ...c, fills: pick(c["fills"] as Json[], 2) } };
        }),
      ].map(A),
    });
  }
}

main();
