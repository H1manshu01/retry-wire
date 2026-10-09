---
title: "Make your LLM calls survive 429s and overloads, with any client"
published: true
description: "LLM endpoints fail with 429s, Anthropic 529 overloads, and Retry-After headers that generic retry libraries don't model — and the official SDKs weld that logic to their own client. retry-wire is a zero-dependency, provider-aware retry and throttle you can wrap around any fetch or any async call."
tags: typescript, ai, opensource, webdev
cover_image: https://raw.githubusercontent.com/H1manshu01/retry-wire/main/assets/cover.png
canonical_url: https://dev.to/h1manshu01/make-your-llm-calls-survive-429s-and-overloads-with-any-client-2lc0
---

You ship an LLM feature. It works. Then, in production, you start seeing this:

```
429 Too Many Requests
529 overloaded_error
503 Service Unavailable
```

So you reach for a retry library — `p-retry`, `async-retry`, a hand-rolled
backoff loop — and wrap the call. And it mostly works, until you notice it's
retrying a `400 Bad Request` (pointless), ignoring the `Retry-After: 2` the
server politely sent (so you wait the wrong amount), and hammering a `429` that
you could have *paced under* in the first place.

The problem is that an LLM endpoint doesn't fail like a generic HTTP service, and
generic retry libraries don't know the difference.

## What's actually different about LLM failures

- A **429** might be a quota limit *or* a momentary burst. Either way the server
  usually tells you how long to wait, in a `Retry-After` (seconds or an HTTP
  date) or a `retry-after-ms` header. A blind exponential backoff ignores it and
  guesses.
- Anthropic adds a **529 `overloaded_error`** — "the service is saturated, try
  again." That's retryable, and it's a *different thing* from a quota `429`. Most
  retry predicates don't even have 529 in their list.
- Providers report your **remaining budget** in `x-ratelimit-remaining-requests`
  / `-tokens` (OpenAI) and `anthropic-ratelimit-*` headers. You can pace against
  that instead of waiting to be told "no."

The official SDKs know all of this. The `openai` and `@anthropic-ai/sdk` clients
retry 429/5xx and honor `retry-after` out of the box. The catch: **that logic
lives inside the client.** The moment you call through a gateway, a proxy, your
own `fetch`, a second provider, or a streaming client, you leave it behind and
you're back to a generic loop.

## retry-wire

[`retry-wire`](https://www.npmjs.com/package/retry-wire) is that provider-aware
retry logic, unbundled — a zero-dependency policy you wrap around **any** `fetch`
or **any** async call. Two functions, same knowledge inside both.

A drop-in `fetch` wrapper:

```ts
import { retryFetch } from "retry-wire";

const rfetch = retryFetch(fetch, { provider: "openai", maxRetries: 5 });

const res = await rfetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  body,
  signal,
});
```

`rfetch` has the exact `fetch` signature, so it drops in anywhere a `fetch` is
accepted. It retries 429 / 529 / 5xx / 408 / 409 and network errors, honors
`Retry-After`, drains the response body before retrying so nothing leaks, and
returns non-retryable responses (200, 400, …) untouched — just like `fetch`.

Or wrap an SDK method — anything that returns a promise:

```ts
import { withResilience } from "retry-wire";

const out = await withResilience(
  (signal) => client.messages.create(params, { signal }),
  {
    provider: "anthropic", // treats 529 overloaded as retryable, distinct from 429
    maxRetries: 5,
    backoff: { initial: 500, max: 60_000, jitter: "full" },
    onRetry: ({ attempt, delayMs, reason }) =>
      console.warn(`retry ${attempt} in ${delayMs}ms: ${reason}`),
  },
);
```

It reads the thrown error's status and headers (matching how the SDK error
objects are shaped), forwards an `AbortSignal` to your call, and never retries an
abort or a non-retryable error.

## Rule packs: the provider knowledge, as data

What makes it provider-aware is a **rule pack** — plain data, not hardcoded
branching:

```ts
interface RulePack {
  name?: string;
  isRetryable(ctx): boolean;                 // is this outcome worth retrying?
  retryAfterMs(headers): number | undefined; // the server's advised wait
  readLimits?(headers): RateLimitInfo;        // remaining request/token budget
}
```

`genericPack`, `openaiPack`, and `anthropicPack` ship built in. `anthropicPack`
is the one that knows `529`; the OpenAI and Anthropic packs also parse the
provider's rate-limit headers. For a gateway, Bedrock, Vertex, or anything with
its own rules, `defineRulePack` gives you a typed custom pack:

```ts
import { defineRulePack, parseRetryAfter } from "retry-wire";

const bedrockPack = defineRulePack({
  name: "bedrock",
  isRetryable: (ctx) => ctx.status === 429 || ctx.status === 503,
  retryAfterMs: (headers) => parseRetryAfter(headers),
});
```

## Don't just react to 429 — avoid it

Retrying reacts to a rate limit. Throttling *avoids* it: pace your own calls
under the tier before the provider has to push back. It's opt-in, built on token
buckets over requests- and tokens-per-minute:

```ts
const rfetch = retryFetch(fetch, {
  provider: "openai",
  throttle: {
    rpm: 50,
    tpm: 40_000,
    estimateTokens: (input, init) => countTokens(init?.body),
  },
});
```

A call that would outrun the budget waits on an abortable timer until a bucket
token is available — so you glide under the limit instead of bouncing off it.

## It composes with sse-wire

If you stream completions, you've probably met
[`sse-wire`](https://www.npmjs.com/package/sse-wire) — a `fetch`-based SSE client
that reconnects a stream only when the connection actually drops. The two solve
different halves of the same problem: `sse-wire` reconnects the *stream*;
`retry-wire` resilience-wraps the *request that opens the stream*, so a 429 or
529 on the way in is retried before a byte streams.

```ts
import { retryFetch } from "retry-wire";
import { sse } from "sse-wire";

const rfetch = retryFetch(fetch, { provider: "openai", maxRetries: 5 });

for await (const event of sse("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages }),
  fetch: rfetch, // open the stream through the resilient fetch
})) {
  if (event.data === "[DONE]") break;
  render(JSON.parse(event.data));
}
```

`retry-wire` is part of a small line of zero-dependency LLM dev tools, each
useful on its own:

- **[`retry-wire`](https://www.npmjs.com/package/retry-wire)** — provider-aware
  retry + throttle for the request. *(this one)*
- **[`sse-wire`](https://www.npmjs.com/package/sse-wire)** — fetch-based SSE
  client: POST, headers, abort, opt-in reconnection.
- **[`trickle-json`](https://www.npmjs.com/package/trickle-json)** — assemble
  streamed token deltas into the best valid partial value on every chunk.
- **[`coerce-json`](https://www.npmjs.com/package/coerce-json)** — repair and
  coerce that value to your Zod / JSON Schema, logging every fix.
- **[`trickle-react`](https://www.npmjs.com/package/trickle-react)** — React
  bindings for the streaming parse.
- **[`expect-llm`](https://www.npmjs.com/package/expect-llm)** — assertions for
  LLM output in tests.

## Why not just use the SDK's retries?

Because they only cover calls made *through* that SDK. One app that talks to
OpenAI and Anthropic has two retry implementations with different knobs; add a
gateway or a raw `fetch` and you have a third, generic one. `retry-wire` is one
policy — `openai` / `anthropic` / `generic` packs plus custom — across every
transport: SDKs, gateways, raw `fetch`, and streaming.

## Try it

```sh
npm install retry-wire
```

- **npm:** https://www.npmjs.com/package/retry-wire
- **GitHub:** https://github.com/H1manshu01/retry-wire
- Zero runtime dependencies, ESM + CJS, full types, ~1.68 kB min+brotli,
  published with provenance. Runs on Node ≥ 18, the browser, and Bun.

If it retries something it shouldn't — or doesn't retry something it should, or
misreads a `Retry-After` — open an issue with the status/headers you saw. The
provider-aware part is the whole point, so I want to know. A star helps if it
saves you a hand-rolled backoff loop.
