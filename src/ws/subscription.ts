/**
 * Library subscription (§4, §4.6): `on()` callbacks are unbuffered; the async iterator has a bounded
 * buffer. Market updates are STATE and coalesce by (dex, symbol) — never fatal. Control events are
 * not coalesced; when they fill the buffer → STREAM_OVERFLOW (fatal): the stream releases the wire
 * subscriptions and the subscription ends.
 *
 * Buffering starts at construction, so an iterator created later still sees the events since
 * subscribe(). Until an iterator exists, control events are kept in a ring of the latest `size`
 * (never fatal: a subscription held without a consumer on a flapping connection cannot overflow);
 * when the iterator attaches, a non-fatal STREAM_OVERFLOW event first reports how many older control
 * events were discarded. Overflow is fatal only once an iterator is attached.
 * A consumer that attaches an on() callback before creating an iterator is a callback consumer: the
 * buffer is dropped and not kept (an iterator created after that starts from its creation).
 */

import { WsError } from "./errors.js";
import type { MarketUpdate, StreamControl, Subscription, VenueId } from "./types.js";

type Item<E> = E | StreamControl;

function coalesceKey(e: { type: string }): string | null {
  if (e.type === "market") {
    const m = e as MarketUpdate;
    return `market|${m.dex === null ? "" : m.dex}|${m.symbol}`;
  }
  return null;
}

export class SubscriptionImpl<E extends { type: string }> implements Subscription<E> {
  status: "pending" | "active" | "rejected" | "closed" = "pending";
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: WsError) => void;
  private listeners = new Set<(e: Item<E>) => void>();
  private iterating = false;
  private buffering = true;
  private queue: Array<{ v: Item<E>; key: string | null }> = [];
  private keyed = new Map<string, { v: Item<E>; key: string | null }>(); // coalesce key → queued box
  private controlsQueued = 0;
  /** Control events discarded from the pre-iterator ring. */
  private droppedBeforeIterator = 0;
  private waiters: Array<(r: IteratorResult<Item<E>>) => void> = [];

  constructor(
    readonly venue: VenueId,
    private bufferSize: number,
    private onUnsubscribe: (sub: SubscriptionImpl<E>) => Promise<void>,
    private onListenerError: (err: unknown) => void,
    /** Buffer overflow: the stream releases the wires and calls fail(err). */
    private onOverflow: (sub: SubscriptionImpl<E>, err: WsError) => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The rejection is also delivered as an `error` control event; avoid an unhandled rejection
    // for consumers that only use on()/the iterator.
    this.ready.catch(() => undefined);
  }

  markActive(): void {
    if (this.status !== "pending") return;
    this.status = "active";
    this.resolveReady();
  }

  /** Reject `ready` (if pending), emit a fatal error event and end the subscription. */
  fail(err: WsError): void {
    if (this.status === "closed" || this.status === "rejected") return;
    const wasPending = this.status === "pending";
    this.deliver({
      type: "error",
      venue: this.venue,
      code: err.structured.code,
      message: err.message,
      remediation: err.structured.remediation === undefined ? null : err.structured.remediation,
      raw: null,
      fatal: true,
    }, true);
    this.status = wasPending ? "rejected" : "closed";
    if (wasPending) this.rejectReady(err);
    this.finish();
  }

  /** End without error (client unsubscribe / stream close). */
  end(): void {
    if (this.status === "closed" || this.status === "rejected") return;
    const wasPending = this.status === "pending";
    this.status = "closed";
    if (wasPending) this.rejectReady(new WsError("INVALID_PARAMS", "Subscription closed before it became ready", { exchange: this.venue }));
    this.finish();
  }

  get closed(): boolean {
    return this.status === "closed" || this.status === "rejected";
  }

  emit(e: Item<E>): void {
    this.deliver(e, false);
  }

  /** `force`: a terminal error event is queued even when the buffer is full. */
  private deliver(e: Item<E>, force: boolean): void {
    if (this.closed) return;
    for (const l of this.listeners) {
      try { l(e); } catch (err) { this.onListenerError(err); }
    }
    if (!this.buffering) return;
    const w = this.waiters.shift();
    if (w !== undefined) { w({ value: e, done: false }); return; }
    const key = coalesceKey(e);
    if (key !== null) {
      const box = this.keyed.get(key);
      if (box !== undefined) {
        const prev = box.v as unknown as MarketUpdate;
        const next = e as unknown as MarketUpdate;
        const changed = Array.from(new Set([...prev.changed, ...next.changed]));
        // A coalesced row that contains a snapshot stays a snapshot.
        const source = prev.source === "snapshot" || next.source === "snapshot" ? "snapshot" : next.source;
        box.v = { ...next, changed, source } as unknown as Item<E>;
        return;
      }
      const nb = { v: e, key };
      this.keyed.set(key, nb);
      this.queue.push(nb);
      return;
    }
    if (!force && !this.iterating && this.controlsQueued >= this.bufferSize) {
      const oldest = this.queue.findIndex(b => b.key === null);
      this.queue.splice(oldest, 1);
      this.controlsQueued--;
      this.droppedBeforeIterator++;
    }
    if (!force && this.controlsQueued >= this.bufferSize) {
      this.onOverflow(this, new WsError("STREAM_OVERFLOW", `Subscription buffer full (${this.bufferSize} events not consumed)`, {
        exchange: this.venue,
        remediation: "Consume the iterator faster, use on() callbacks, or raise opts.buffer.size",
      }));
      return;
    }
    this.controlsQueued++;
    this.queue.push({ v: e, key: null });
  }

  on(cb: (e: Item<E>) => void): () => void {
    if (!this.iterating) this.clearBuffer(false);
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  unsubscribe(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.onUnsubscribe(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<Item<E>> {
    if (!this.iterating && this.droppedBeforeIterator > 0) {
      if (this.controlsQueued >= this.bufferSize) { // make room for the summary (counted in the buffer)
        this.queue.splice(this.queue.findIndex(b => b.key === null), 1);
        this.controlsQueued--;
        this.droppedBeforeIterator++;
      }
      const n = this.droppedBeforeIterator;
      this.droppedBeforeIterator = 0;
      this.queue.unshift({
        v: {
          type: "error", venue: this.venue, code: "STREAM_OVERFLOW",
          message: `${n} older control event(s) were discarded before an iterator attached (latest ${this.bufferSize} kept)`,
          remediation: "Create the iterator (or attach on()) right after subscribe()", raw: null, fatal: false,
        },
        key: null,
      });
      this.controlsQueued++;
    }
    this.iterating = true;
    this.buffering = true;
    const stop = async (): Promise<IteratorResult<Item<E>>> => {
      this.clearBuffer(true);
      await this.unsubscribe();
      return { value: undefined, done: true } as IteratorResult<Item<E>>;
    };
    return {
      next: () => {
        const box = this.queue.shift();
        if (box !== undefined) {
          if (box.key === null) this.controlsQueued--;
          else this.keyed.delete(box.key);
          return Promise.resolve({ value: box.v, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true } as IteratorResult<Item<E>>);
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: stop,
      throw: async (err?: unknown) => {
        await stop();
        throw err;
      },
    };
  }

  private clearBuffer(keepBuffering: boolean): void {
    this.queue = [];
    this.keyed.clear();
    this.controlsQueued = 0;
    this.droppedBeforeIterator = 0;
    this.buffering = keepBuffering;
  }

  private finish(): void {
    // Queued items stay readable; waiters (queue empty) end now.
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true } as IteratorResult<Item<E>>);
  }
}
