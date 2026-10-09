import { describe, expect, it } from "vitest";
import { Throttle } from "../src/index.js";
import { fakeClock } from "./helpers.js";

describe("Throttle (rpm)", () => {
  it("lets a full bucket through, then paces at the refill rate", async () => {
    const clock = fakeClock();
    const t = new Throttle({ rpm: 60 }, clock.now()); // 60/min => 1/sec, capacity 60, starts full

    for (let i = 0; i < 60; i++) await t.acquire(1, clock.now, clock.sleep);
    expect(clock.delays).toEqual([]); // nothing waited while the bucket had tokens

    await t.acquire(1, clock.now, clock.sleep); // bucket empty -> wait one refill
    expect(clock.delays).toEqual([1000]);
  });
});

describe("Throttle (tpm)", () => {
  it("paces on token cost", async () => {
    const clock = fakeClock();
    const t = new Throttle({ tpm: 6000 }, clock.now()); // 6000/min => 100/ms? no: 6000/60000 = 0.1 tokens/ms

    await t.acquire(6000, clock.now, clock.sleep); // consumes the full bucket, no wait
    expect(clock.delays).toEqual([]);

    await t.acquire(600, clock.now, clock.sleep); // need 600 tokens at 0.1/ms => 6000 ms
    expect(clock.delays).toEqual([6000]);
  });
});
