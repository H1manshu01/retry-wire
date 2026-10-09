import { describe, expect, it, vi } from "vitest";
import { retryFetch } from "../src/index.js";
import { fakeClock, resp } from "./helpers.js";

const BACKOFF = { initial: 100, max: 60_000, factor: 2, jitter: "none" as const };

describe("retryFetch", () => {
  it("retries a 429 (honoring Retry-After) then returns 200", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return n === 1 ? resp(429, { "retry-after": "1" }) : resp(200);
    });
    const rfetch = retryFetch(fetchImpl as unknown as typeof fetch, {
      provider: "openai",
      backoff: BACKOFF,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await rfetch("https://x.test", { method: "POST" });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
    expect(clock.delays).toEqual([1000]);
  });

  it("returns a non-retryable 400 as-is without retrying", async () => {
    const fetchImpl = vi.fn(async () => resp(400));
    const rfetch = retryFetch(fetchImpl as unknown as typeof fetch, {});
    const r = await rfetch("https://x.test");
    expect(r.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a network error then succeeds", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError("network error");
      return resp(200);
    });
    const rfetch = retryFetch(fetchImpl as unknown as typeof fetch, {
      backoff: BACKOFF,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await rfetch("https://x.test");
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });

  it("gives up after maxRetries and returns the last response", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => resp(503));
    const rfetch = retryFetch(fetchImpl as unknown as typeof fetch, {
      maxRetries: 2,
      backoff: BACKOFF,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await rfetch("https://x.test");
    expect(r.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
