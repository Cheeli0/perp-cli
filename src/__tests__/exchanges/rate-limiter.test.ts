/** L5: the token bucket survives the wall clock stepping backwards (NTP, VM resume, fake timers). */
import { describe, it, expect, vi, afterEach } from "vitest";
import { acquireRate } from "../../exchanges/rate-limiter.js";

describe("rate limiter: clock steps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a backwards clock step does not stall requests", async () => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - offsetMs);
    const policy = { capacity: 1, refillPerSec: 100, weights: null };
    const key = `clock-step-${Math.random()}`;
    await acquireRate(key, policy, "/x"); // bucket created and drained at "now"
    offsetMs = 60_000; // the clock jumps back one minute
    const start = realNow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">(r => { timer = setTimeout(() => r("stalled"), 2_000); });
    const done = (async () => {
      for (let i = 0; i < 3; i++) await acquireRate(key, policy, "/x");
      return "done" as const;
    })();
    expect(await Promise.race([done, stalled])).toBe("done");
    clearTimeout(timer);
    // Still rate limited at the policy's pace (3 tokens at 100/s ≈ 30 ms), not free.
    expect(realNow() - start).toBeGreaterThanOrEqual(20);
  });
});
