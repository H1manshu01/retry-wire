# Roadmap

`retry-wire` ships `M0–M5` as **v0.1** — the retry engine (`withResilience` +
`retryFetch`), the provider rule packs (`openai` / `anthropic` / `generic` +
custom), the token-bucket `Throttle`, the backoff curve, the tests, and the docs
are all in place. It is a standalone tool in the author's LLM dev-tools line; it
composes with [`sse-wire`](https://github.com/H1manshu01/sse-wire) —
`sse-wire` reconnects a dropped stream, `retry-wire` resilience-wraps the request
that opens it.

## M0 — Validate & name (done)
- [x] Competitor scan: `p-retry`, `cockatiel`, `exponential-backoff`,
      `async-retry`, `ky` retry, and the openai-node / `@anthropic-ai/sdk`
      built-in retries (see [COMPETITORS.md](./COMPETITORS.md))
- [x] Confirmed the gap: generic retry libraries don't model provider rate-limit
      semantics (429 vs. Anthropic's 529, `Retry-After` / `retry-after-ms`,
      `x-ratelimit-*`), and the SDKs that *do* weld that logic to their own
      client — so a gateway, a raw `fetch`, or a streaming client loses it
- [x] Named and scoped as a transport-agnostic, provider-aware retry + throttle
      layer

## M1 — Retry engine (done)
- [x] `withResilience(op, options?)` wraps any async op; retries on thrown
      errors, forwards an `AbortSignal` to the op (`src/core.ts`)
- [x] `retryFetch(fetch?, options?)` drop-in fetch wrapper; retries on retryable
      responses (429 / 529 / 5xx / 408 / 409) and network errors, drains the body
      before retrying, returns non-retryable responses as-is
- [x] `computeBackoff(attempt, backoff)` — exponential base `min(initial *
      factor ** attempt, max)` with `full` / `equal` / `none` jitter
- [x] Honors `Retry-After` / `retry-after-ms` over the backoff curve
      (`respectRetryAfter`); non-idempotent calls never retried; abort cancels a
      pending backoff wait; deterministic via injectable `now` / `sleep`

## M2 — Provider rule packs (done)
- [x] `RulePack` as data (`isRetryable` / `retryAfterMs` / optional `readLimits`)
      — no hardcoded provider branching (`src/rules.ts`)
- [x] `genericPack` (network + 408/409/429/5xx), `openaiPack` (+ `x-ratelimit-*`
      and `x-ratelimit-reset-*` duration parsing), `anthropicPack` (+ 529
      overloaded, + `anthropic-ratelimit-*`)
- [x] `parseRetryAfter` (ms header, seconds, or HTTP date), `resolvePack`
      (name / pack / undefined → pack), `defineRulePack` for custom providers
      (gateways, Bedrock, Vertex)

## M3 — Throttling (done)
- [x] `Throttle` class: token buckets over RPM and TPM, refilled continuously
      over a one-minute window, waiting on the injectable `sleep` (`src/throttle.ts`)
- [x] `rpm` paces both wrappers; `tpm` + `estimateTokens(input, init)` pace
      `retryFetch` (which holds the request); a per-call cost is charged to the
      TPM bucket
- [x] Opt-in via `throttle` on `ResilienceOptions`; abort cancels a throttle wait

## M4 — Tests & size (done)
- [x] `computeBackoff` (exponential, cap, full/equal jitter bounds) and
      `withResilience` (retry-then-succeed with recorded delays, `Retry-After`
      over curve, give-up after `maxRetries`, no-retry on 400 / `idempotent:
      false`, Anthropic 529, abort during wait, already-aborted signal) —
      `test/core.test.ts`
- [x] `retryFetch` (429 + `Retry-After`, non-retryable 400 as-is, network-error
      retry, give-up returns last response) — `test/retryFetch.test.ts`
- [x] Rule packs (`parseRetryAfter` ms / seconds / HTTP date, `isRetryable`
      matrices, OpenAI + Anthropic `readLimits`, `resolvePack`) —
      `test/rules.test.ts`
- [x] `Throttle` RPM pacing and TPM token-cost pacing — `test/throttle.test.ts`
- [x] 25 tests pass; `size-limit` budget on the built `dist/index.js`

## M5 — Docs / CI / release (done)
- [x] README with the problem, both quick starts, the options table, provider
      rule packs (openai / anthropic / custom), a Throttling section, the
      sse-wire composition note, a Guardrails section, and a comparison table
- [x] `COMPETITORS.md`, `CHANGELOG.md`, launch post draft
- [x] ESM + CJS + `.d.ts` build (tsup); zero-dependency; ~1.68 kB min+brotli
- [ ] npm publish with `--provenance` — needs an `NPM_TOKEN` secret and a
      `v0.1.0` tag (owner action)

## Post-1.0 ideas
- **Circuit breaker.** An opt-in breaker that trips open after a run of failures
  and short-circuits calls for a cooldown, so a struggling endpoint isn't hammered
  while it's down — complementing per-call retry with a cross-call state machine.
- **More provider packs.** First-class `bedrock`, `vertex`, `azure`, and
  `mistral` packs, each modeling that provider's status codes, `Retry-After`
  variants, and rate-limit headers — so a custom `defineRulePack` isn't needed for
  the common gateways.
- **Adaptive pacing from `readLimits`.** Feed the `x-ratelimit-*` /
  `anthropic-ratelimit-*` headers (already parsed by `readLimits`) back into the
  throttle, so the client self-tunes to the *remaining* budget the server reports
  rather than a static RPM/TPM you configured by hand.
- **Request de-dup / hedging.** Coalesce identical in-flight idempotent requests,
  and optionally hedge a slow request with a second attempt after a percentile
  delay, cancelling the loser.

## Known trade-offs (document, don't hide)
- **`idempotent` defaults to `true`.** This is correct for LLM completions, which
  have no side effects — but it means a call *with* side effects is retried unless
  you set `idempotent: false`. The default favors the common case; flip it for any
  mutating call.
- **Throttle is per-process, in-memory.** The token buckets pace one Node process
  or one browser tab. They are **not** a distributed limiter — multiple processes
  or machines each keep their own buckets, so the aggregate rate can exceed a
  single bucket's limit. Use a shared/distributed limiter if you need a
  fleet-wide cap.
- **`withResilience` paces on RPM only.** TPM pacing needs a per-call token cost,
  which only `retryFetch` computes from the request via `estimateTokens`. A TPM
  limit set on a `withResilience` throttle is inert; pace token spend through
  `retryFetch`, or the `Throttle` class directly.
- **No built-in request timeout.** Compose one with `AbortSignal.timeout(ms)` on
  the `signal` option rather than a bespoke timeout flag.
- **`retryFetch` never throws on an HTTP status.** Like `fetch`, a non-retryable
  response (e.g. a final 429 after `maxRetries`, or a 400) is returned for you to
  inspect — it is not converted into a thrown error.
