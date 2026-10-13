/**
 * Private (user) state (§4, §6.3): positions and open orders are kept as the latest venue snapshot
 * plus merged deltas, partitioned by `scope` (HL: one snapshot per perp dex), and every change emits
 * the FULL current set. Fills are events, de-duplicated over a bounded LRU window by
 * (fillId, side, orderId) — the side/order keep both legs of a self-trade, which share the venue's
 * trade id. A replayed fill snapshot (HL / Arcus re-send recent fills on every resubscribe) is one
 * `fills` event with only the unseen fills; when its OLDEST fill is unseen while earlier fills were
 * seen, fills may have been missed beyond the replay window → the caller emits a refetch gap.
 */

import type { FillRow, OrderRow, PositionRow, UserDelta, UserUpdate, VenueId } from "./types.js";

/** Remembered fill keys per stream (bounded). Larger than any venue's replay window (HL 2000, Arcus 500). */
export const FILL_DEDUPE_WINDOW = 20_000;

export interface UserApplyResult {
  updates: UserUpdate[];
  /** A replayed fill snapshot does not overlap what was seen before (outage longer than the replay window). */
  fillsGap: boolean;
}

export class UserStore {
  private positions = new Map<string, Map<string, PositionRow>>();
  private orders = new Map<string, Map<string, OrderRow>>();
  /** Order scopes that received a venue snapshot since they were (re)created. */
  private ordersComplete = new Set<string>();
  private seenFills = new Map<string, true>();

  constructor(private venue: VenueId) {}

  apply(d: UserDelta, recvTs: number): UserApplyResult {
    const source = d.kind !== "fills" && d.snapshot ? "snapshot" : "ws";
    switch (d.kind) {
      case "account":
        return {
          fillsGap: false,
          updates: [{
            type: "account", schema: 1, venue: this.venue, dex: d.dex,
            equity: d.equity === undefined ? null : d.equity,
            available: d.available === undefined ? null : d.available,
            marginUsed: d.marginUsed === undefined ? null : d.marginUsed,
            unrealizedPnl: d.unrealizedPnl === undefined ? null : d.unrealizedPnl,
            venueTs: d.venueTs, source, recvTs,
          }],
        };
      case "positions":
        mergeScope(this.positions, d.scope, d.snapshot, d.rows.map(r => [posKey(r), r] as const), d.remove);
        return { fillsGap: false, updates: [{ type: "positions", schema: 1, venue: this.venue, snapshot: d.snapshot, positions: flatten(this.positions), source, recvTs }] };
      case "orders":
        mergeScope(this.orders, d.scope, d.snapshot, d.rows.map(r => [r.orderId, r] as const), d.remove);
        if (d.snapshot) this.ordersComplete.add(d.scope);
        return { fillsGap: false, updates: [this.ordersEvent(d.snapshot, recvTs)] };
      case "fills":
        return this.applyFills(d.snapshot, d.fills, recvTs);
    }
  }

  /** A non-replayable order channel had a gap: forget its (now unknown) open orders. */
  clearOrders(recvTs: number): UserUpdate {
    this.orders.clear();
    this.ordersComplete.clear();
    return this.ordersEvent(false, recvTs);
  }

  currentOrders(recvTs: number): UserUpdate {
    return this.ordersEvent(false, recvTs);
  }

  private ordersEvent(snapshot: boolean, recvTs: number): UserUpdate {
    const scopes = Array.from(this.orders.keys());
    const complete = scopes.length > 0 && scopes.every(s => this.ordersComplete.has(s));
    return { type: "orders", schema: 1, venue: this.venue, snapshot, complete, orders: flatten(this.orders), source: snapshot ? "snapshot" : "ws", recvTs };
  }

  private applyFills(snapshot: boolean, fills: FillRow[], recvTs: number): UserApplyResult {
    const hadHistory = this.seenFills.size > 0;
    const fresh: FillRow[] = [];
    let oldest: FillRow | null = null;
    for (const f of fills) {
      if (oldest === null || (f.time !== null && (oldest.time === null || f.time < oldest.time))) oldest = f;
    }
    const oldestUnseen = oldest !== null && !this.seenFills.has(fillKey(oldest));
    for (const f of fills) {
      const k = fillKey(f);
      if (this.seenFills.has(k)) continue;
      this.remember(k);
      fresh.push(f);
    }
    const fillsGap = snapshot && hadHistory && oldestUnseen;
    if (fresh.length === 0) return { fillsGap, updates: [] };
    if (snapshot) {
      return { fillsGap, updates: [{ type: "fills", schema: 1, venue: this.venue, snapshot: true, fills: fresh, source: "snapshot", recvTs }] };
    }
    return {
      fillsGap,
      updates: fresh.map(fill => ({ type: "fill", schema: 1, venue: this.venue, snapshot: false, fillId: fill.fillId, fill, source: "ws", recvTs }) as UserUpdate),
    };
  }

  private remember(k: string): void {
    this.seenFills.set(k, true);
    if (this.seenFills.size > FILL_DEDUPE_WINDOW) {
      const first = this.seenFills.keys().next();
      if (first.done !== true) this.seenFills.delete(first.value);
    }
  }
}

function fillKey(f: FillRow): string {
  return `${f.fillId}|${f.side === null ? "" : f.side}|${f.orderId === null ? "" : f.orderId}`;
}

function posKey(r: PositionRow): string {
  return `${r.dex === null ? "" : r.dex}|${r.symbol}`;
}

/** `remove` matches a key exactly or its "<dex>|<symbol>" suffix (positions are removed by symbol). */
function mergeScope<T>(all: Map<string, Map<string, T>>, scope: string, snapshot: boolean, rows: ReadonlyArray<readonly [string, T]>, remove: string[]): void {
  let m = all.get(scope);
  if (m === undefined || snapshot) { m = new Map(); all.set(scope, m); }
  for (const k of remove) {
    for (const key of Array.from(m.keys())) if (key === k || key.endsWith(`|${k}`)) m.delete(key);
  }
  for (const [k, v] of rows) m.set(k, v);
}

function flatten<T>(all: Map<string, Map<string, T>>): T[] {
  const out: T[] = [];
  for (const m of all.values()) for (const v of m.values()) out.push(v);
  return out;
}
