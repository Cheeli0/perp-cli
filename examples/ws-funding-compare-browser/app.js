// Live funding comparison across venues with perp-cli/ws (browser, native WebSocket, no framework).
// startFundingCompare(root) renders: connection state per venue, the comparator's top rows
// (kind "next": accruing where published, else predicted), and the bbo of the two extreme legs of the
// selected row. Returns stop(). Used as-is by index.html (import map) and the Next 13.5 smoke build.
import {
  arcus, aster, createFundingComparator, createVenueStream, hyperliquid, lighter, lighterRh, pacifica, toApr, toHourly,
} from "perp-cli/ws";

const CODECS = [hyperliquid, pacifica, lighter, lighterRh, aster, arcus];
const TOP = 25;

const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(2)}%`);

export function startFundingCompare(root, { kind = "next", venues = CODECS } = {}) {
  root.innerHTML = `
    <section><h2>Connections</h2><ul data-states></ul></section>
    <section><h2 data-title></h2>
      <table><thead><tr><th>market</th><th>legs</th><th>high</th><th>low</th><th>spread</th><th>kinds</th></tr></thead><tbody data-rows></tbody></table>
    </section>
    <section><h2>Top of book <small data-pair></small></h2><pre data-bbo>Select a row.</pre></section>
    <section><h2>Errors</h2><pre data-errors></pre></section>`;
  const $ = (sel) => root.querySelector(sel); // the template above is static (no data interpolated)
  $("[data-title]").textContent = `Funding (${kind}), APR`;
  const streams = venues.map((codec) => createVenueStream(codec)); // global WebSocket + fetch
  const states = new Map();
  const errors = [];
  const offs = [];

  // Venue data (symbols, HIP-3 dex names are permissionless) is only ever set as textContent.
  const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
  const renderStates = () => {
    $("[data-states]").replaceChildren(...streams.map((s) => {
      const li = el("li", `${s.venue}: `);
      li.appendChild(el("b", states.get(s.venue) ?? s.state.status));
      return li;
    }));
  };
  for (const s of streams) offs.push(s.onState((st) => { states.set(s.venue, st.status); renderStates(); }));
  renderStates();

  const comparator = createFundingComparator({
    streams,
    kind,
    onControl: (c) => {
      if (c.type !== "error" && c.type !== "listener-error") return;
      errors.unshift(`${c.type === "error" ? `${c.venue} ${c.code}` : "listener"}: ${c.message}`);
      errors.length = Math.min(errors.length, 8);
      $("[data-errors]").textContent = errors.join("\n");
    },
  });

  // Compare like-for-like: per-hour rate (never pre-annualized in events), fresh legs only.
  const score = (row) => {
    const legs = row.legs
      .filter((l) => l.rate !== null && !l.stale)
      .map((l) => ({ l, h: toHourly(l.rate, l.funding.rateIntervalHours) }))
      .filter((x) => x.h !== null)
      .sort((a, b) => a.h - b.h);
    if (legs.length < 2) return null;
    const lo = legs[0];
    const hi = legs[legs.length - 1];
    return { row, lo, hi, spread: (hi.h - lo.h) * 24 * 365 };
  };

  let selected = null;
  let bboSubs = [];
  const bboText = new Map();
  const selectPair = (s) => {
    for (const sub of bboSubs) void sub.unsubscribe();
    bboSubs = [];
    bboText.clear();
    selected = s.row.canonical;
    $("[data-pair]").textContent = `${s.row.canonical}: short ${s.hi.l.venue} / long ${s.lo.l.venue}`;
    for (const leg of [s.hi.l, s.lo.l]) {
      const stream = streams.find((x) => x.venue === leg.venue);
      if (stream === undefined || !stream.capabilities.channels.bbo) continue;
      const sub = stream.subscribe({ kind: "market", symbol: leg.symbol, channels: ["bbo"] });
      sub.on((e) => {
        if (e.type !== "bbo") return;
        bboText.set(leg.venue, `${leg.venue.padEnd(11)} ${leg.symbol.padEnd(12)} bid ${e.bid ?? "—"} (${e.bidSize ?? "—"})  ask ${e.ask ?? "—"} (${e.askSize ?? "—"})`);
        $("[data-bbo]").textContent = Array.from(bboText.values()).join("\n");
      });
      bboSubs.push(sub);
    }
  };

  const render = (rows) => {
    const top = rows.map(score).filter((x) => x !== null).sort((a, b) => b.spread - a.spread).slice(0, TOP);
    const body = $("[data-rows]");
    body.replaceChildren(...top.map((s) => {
      const tr = el("tr");
      if (s.row.canonical === selected) tr.style.fontWeight = "bold";
      for (const text of [
        s.row.canonical,
        String(s.row.legs.length),
        `${s.hi.l.venue} ${pct(toApr(s.hi.l.rate, s.hi.l.funding.rateIntervalHours))}`,
        `${s.lo.l.venue} ${pct(toApr(s.lo.l.rate, s.lo.l.funding.rateIntervalHours))}`,
        pct(s.spread),
        s.row.mixedKinds ? "mixed" : String(s.hi.l.rateKind),
      ]) tr.appendChild(el("td", text));
      tr.style.cursor = "pointer";
      tr.onclick = () => selectPair(s);
      return tr;
    }));
  };
  let last = 0;
  offs.push(comparator.subscribe((rows) => {
    const now = Date.now();
    if (now - last < 1000) return; // UI coalescing ~1/s
    last = now;
    render(rows);
  }));

  return async function stop() {
    for (const off of offs) off();
    for (const sub of bboSubs) await sub.unsubscribe();
    comparator.close();
    await Promise.all(streams.map((s) => s.close()));
  };
}
