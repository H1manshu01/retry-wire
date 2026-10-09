// Cross-runtime smoke test against the BUILT output (dist/).
// Runs under both Node and Bun to confirm the published package loads and works.
// No real network: an injected fake `fetch` plus injected `sleep`/`now` keep it
// deterministic and instant — no timers fire and no clock advances on its own.
import assert from "node:assert/strict";
import {
  computeBackoff,
  parseRetryAfter,
  resolvePack,
  retryFetch,
  withResilience,
} from "../dist/index.js";

// A deterministic clock: `now()` reads `t`, `sleep(ms)` records the delay and
// advances `t` by it. No real time passes, so the whole suite runs instantly.
function makeClock() {
  let t = 0;
  const delays = [];
  const now = () => t;
  const sleep = async (ms) => {
    delays.push(ms);
    t += ms;
  };
  return { now, sleep, delays };
}

// retryFetch: a 429 with `Retry-After: 1` is retried once and then succeeds.
// The injected sleep must record [1000] (one second, honored from the header).
{
  const { now, sleep, delays } = makeClock();
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("x", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response("ok", { status: 200 });
  };

  const fetch = retryFetch(fakeFetch, { now, sleep, backoff: { jitter: "none" } });
  const res = await fetch("https://example.test/v1/thing");

  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
}

// withResilience: an operation that throws { status: 500 } twice then returns.
// No Retry-After, so delays follow the backoff schedule: initial 100, factor 2.
{
  const { now, sleep, delays } = makeClock();
  let attempts = 0;
  const op = async () => {
    attempts += 1;
    if (attempts <= 2) {
      throw { status: 500 };
    }
    return "ok";
  };

  const result = await withResilience(op, {
    now,
    sleep,
    backoff: { initial: 100, factor: 2, jitter: "none" },
  });

  assert.equal(result, "ok");
  assert.deepEqual(delays, [100, 200]);
}

// computeBackoff: deterministic exponential growth when jitter is disabled.
{
  const opts = { initial: 100, max: 60000, factor: 2, jitter: "none" };
  assert.equal(computeBackoff(0, opts), 100);
  assert.equal(computeBackoff(2, opts), 400);
}

// parseRetryAfter: a numeric `Retry-After` in seconds becomes milliseconds.
{
  const headers = new Headers({ "retry-after": "2" });
  assert.equal(parseRetryAfter(headers), 2000);
}

// resolvePack: provider-aware retry rules.
// Anthropic treats 529 (overloaded) as retryable; generic does not retry 400.
{
  const anthropic = resolvePack("anthropic");
  const generic = resolvePack("generic");
  assert.equal(anthropic.isRetryable({ status: 529 }), true);
  assert.equal(generic.isRetryable({ status: 400 }), false);
}

console.log(`smoke ok (${typeof Bun !== "undefined" ? "bun" : "node"})`);
