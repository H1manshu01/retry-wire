import { describe, expect, it, vi } from "vitest";
import { computeBackoff, withResilience } from "../src/index.js";
import { fakeClock } from "./helpers.js";

const BACKOFF = { initial: 100, max: 60_000, factor: 2, jitter: "none" as const };

describe("computeBackoff", () => {
  it("is exponential with no jitter and respects the cap", () => {
    expect(computeBackoff(0, BACKOFF)).toBe(100);
    expect(computeBackoff(1, BACKOFF)).toBe(200);
    expect(computeBackoff(2, BACKOFF)).toBe(400);
    expect(computeBackoff(20, BACKOFF)).toBe(60_000);
  });
  it("full jitter stays within [0, base]", () => {
    for (let i = 0; i < 100; i++) {
      const d = computeBackoff(2, { ...BACKOFF, jitter: "full" });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
  it("equal jitter stays within [base/2, base]", () => {
    for (let i = 0; i < 100; i++) {
      const d = computeBackoff(2, { ...BACKOFF, jitter: "equal" });
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
});

describe("withResilience", () => {
  it("retries a failing op then succeeds, recording exponential delays", async () => {
    const clock = fakeClock();
    let calls = 0;
    const onRetry = vi.fn();
    const op = async () => {
      calls++;
      if (calls <= 2) throw { status: 500 };
      return "ok";
    };
    const res = await withResilience(op, {
      maxRetries: 3,
      backoff: BACKOFF,
      now: clock.now,
      sleep: clock.sleep,
      onRetry,
    });
    expect(res).toBe("ok");
    expect(calls).toBe(3);
    expect(clock.delays).toEqual([100, 200]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith({
      attempt: 2,
      delayMs: 200,
      reason: "HTTP 500",
      status: 500,
    });
  });

  it("honors Retry-After over the backoff curve", async () => {
    const clock = fakeClock();
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw { status: 429, headers: { "retry-after": "2" } };
      return "ok";
    };
    await withResilience(op, { backoff: BACKOFF, now: clock.now, sleep: clock.sleep });
    expect(clock.delays).toEqual([2000]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const clock = fakeClock();
    let calls = 0;
    const op = async () => {
      calls++;
      throw { status: 503 };
    };
    await expect(
      withResilience(op, { maxRetries: 2, backoff: BACKOFF, now: clock.now, sleep: clock.sleep }),
    ).rejects.toEqual({ status: 503 });
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does not retry a 400 or when idempotent is false", async () => {
    let calls = 0;
    await expect(
      withResilience(
        async () => {
          calls++;
          throw { status: 400 };
        },
        { maxRetries: 3 },
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      withResilience(
        async () => {
          calls++;
          throw { status: 500 };
        },
        { idempotent: false },
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it("retries Anthropic 529 overloaded", async () => {
    const clock = fakeClock();
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw { status: 529 };
      return "ok";
    };
    await withResilience(op, {
      provider: "anthropic",
      backoff: BACKOFF,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(calls).toBe(2);
  });

  it("propagates an abort that happens during the retry wait", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw { status: 500 };
    };
    const sleep = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    await expect(withResilience(op, { sleep })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("throws immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withResilience(
        async () => {
          calls++;
          return "x";
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});
