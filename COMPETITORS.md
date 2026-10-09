# Competitor scan (M0)

Why `retry-wire` exists: retrying a failed call is well-trodden ground, but the
**LLM-API** case needs a specific combination — retries keyed to provider
rate-limit semantics (a quota `429` vs. Anthropic's `529 overloaded_error`, plus
`408` / `409` / `5xx` and network errors), honoring the server's `Retry-After` /
`retry-after-ms` **over** a blind backoff curve, optional client-side pacing to
stay *under* a tier's RPM/TPM limits, an `AbortSignal` that cancels a pending
backoff wait, and a policy that is **not** welded to one HTTP client. Each
existing option covers part of that; the gaps are exactly where LLM traffic
lives.

Where a specific detail of a third-party library could have changed, claims are
dated **"as of early 2026"** and kept general rather than invented. Re-check
current behavior against each project before quoting it. The aim here is a fair
map of the space, not a takedown — several of these are excellent at what they
were built for, and `retry-wire` is a thin layer that could sit on top of a few
of them.

---

## `p-retry`

**What it does.** A tiny, popular wrapper (built on `retry`) that re-runs a
promise-returning function with exponential backoff until it resolves or the
attempts run out. You can throw an `AbortError` to stop early, and an
`onFailedAttempt` hook reports each miss. Clean, focused, widely used.

**What it misses.**
- **No provider rate-limit knowledge.** It retries on *any* rejection by default;
  it has no concept of a `429` vs. a `400`, an Anthropic `529`, or a `Retry-After`
  header. You implement "retry only on these statuses, wait what the server
  asked" yourself in the callback. `retry-wire` ships that as rule packs.
- **No `Retry-After` honoring.** Backoff is computed from the curve; the server's
  advised wait isn't read. `retry-wire` prefers `Retry-After` / `retry-after-ms`
  when present.
- **No client-side pacing.** It reacts to failures; it can't keep you *under* an
  RPM/TPM limit in the first place. `retry-wire` adds opt-in token-bucket
  throttling.
- **Transport-agnostic, like `retry-wire`.** This part it shares — it wraps any
  promise. `retry-wire`'s difference is the LLM-shaped policy *inside* the wrap,
  plus a drop-in `fetch` variant and a deterministic injectable clock.

## `cockatiel`

**What it does.** A full resilience toolkit (Polly-inspired): retry, circuit
breaker, timeout, bulkhead, fallback, and policy composition. As of early 2026
it's the most feature-complete option here — you can build sophisticated,
composable failure-handling policies, including a rate-limit/bulkhead policy.

**What it misses.**
- **Generic, not provider-aware.** Its retry and backoff are general-purpose; it
  has no built-in notion of an LLM provider's status codes, `Retry-After`
  semantics, or `x-ratelimit-*` headers. You'd encode all of that in a custom
  `handleResultType` / backoff. `retry-wire` is that encoding, ready-made.
- **Pacing is concurrency/bulkhead, not token-aware.** Its throttling limits
  *concurrency*; it doesn't pace against a requests-per-minute or
  **tokens**-per-minute budget the way an LLM tier is denominated. `retry-wire`'s
  `Throttle` is RPM/TPM with a per-request token estimate.
- **Larger surface for one job.** It's a toolkit; if all you need is
  LLM-aware retry around a `fetch` or an SDK call, it's a lot of API to wire up.
  `retry-wire` is a two-function surface. (Its circuit breaker is genuinely
  something `retry-wire` doesn't have — a post-1.0 idea.)

## `exponential-backoff`

**What it does.** A small utility that does exactly what its name says: call a
promise-returning function with configurable exponential backoff and jitter,
with a `retry` predicate to decide whether to keep going. Minimal and dependable.

**What it misses.**
- **Backoff only — no provider rules, no `Retry-After`.** It computes delays; the
  decision of *what* to retry is a predicate you write, and the server's advised
  wait isn't consulted. `retry-wire` bundles the retryable-status rules and
  `Retry-After` honoring.
- **No pacing, no fetch variant, no abort-cancellable wait documented.** It's a
  backoff loop, not an LLM-API resilience layer. `retry-wire` adds the rule
  packs, the throttle, the `retryFetch` drop-in, and an `AbortSignal` that
  cancels the pending wait.

## `async-retry`

**What it does.** A thin, well-loved wrapper around `retry` (the same core
`p-retry` builds on): run an async function, retry with backoff, bail early by
throwing `AbortError`. Slightly lower-level than `p-retry`, same essential shape.

**What it misses.**
- **Same gaps as `p-retry`.** No provider rate-limit semantics, no `Retry-After`
  honoring, no client-side RPM/TPM pacing — those are yours to build in the
  `onRetry` callback and the thrown-error logic. It's a generic retry loop, not an
  LLM-aware one.
- **No `fetch` variant.** You wrap each call by hand; there's no drop-in resilient
  `fetch`. `retry-wire` gives you both `withResilience` (any promise) and
  `retryFetch` (any `fetch`), sharing one policy.

## `ky` retry (built in)

**What it does.** `ky` is a popular `fetch`-based HTTP client with retry built
in. As of early 2026 it retries idempotent methods on a set of status codes
(including `408`, `413`, `429`, `500`, `502`, `503`, `504`) and **honors the
`Retry-After` header** on `429` / `503` — notably more LLM-aware than the generic
retry utilities above.

**What it misses.**
- **Welded to `ky`.** The retry only works for requests made *through* `ky`. The
  moment you use a provider SDK, a raw `fetch`, a gateway client, or
  [`sse-wire`](https://github.com/H1manshu01/sse-wire) for streaming, you leave
  the retry behind. `retry-wire`'s `retryFetch` wraps *any* `fetch`, and
  `withResilience` wraps *any* async call — including an SDK method.
- **No Anthropic `529` by default / not provider-shaped.** Its status set is a
  fixed generic list; it doesn't model a `529 overloaded_error` as distinct from a
  quota `429`, and there's no swap-in provider rule pack. `retry-wire`'s
  `anthropicPack` does, and a custom pack handles any gateway.
- **No token-aware pacing.** It reacts to a `429`; it won't pace you under an
  RPM/**TPM** budget beforehand. `retry-wire` adds the throttle.
- **Dependency footprint.** Retry comes bundled inside `ky`; you adopt the whole
  client. `retry-wire` is a zero-dependency policy you point at whatever client
  you already use.

## openai-node / `@anthropic-ai/sdk` built-in retries

**What they do.** Both official SDKs retry automatically (as of early 2026):
typically a couple of retries by default on connection errors, `408`, `409`,
`429`, and `5xx`, with backoff, and they honor the `retry-after` /
`retry-after-ms` headers. You can tune `maxRetries` per client or per request.
This is the closest thing to `retry-wire`'s rules — because it *is* essentially
the same rules, implemented inside each SDK. They know their own provider
perfectly.

**What they miss.**
- **The logic is welded to the client.** It only applies to calls made through
  that SDK's own request pipeline. Use a gateway, a proxy, a raw `fetch`, a
  different provider's SDK, or a streaming client like `sse-wire`, and you lose
  the retry entirely — or you reimplement it per call site. `retry-wire` lifts the
  same policy out so one wrapper covers every transport and both providers.
- **One provider per SDK.** The OpenAI SDK knows OpenAI; the Anthropic SDK knows
  Anthropic. A single app that talks to both (or to a gateway in front of several)
  has two retry implementations with different knobs. `retry-wire` offers
  `openai` / `anthropic` / `generic` packs and `defineRulePack` behind one API.
- **No client-side RPM/TPM pacing.** They retry a `429`; they don't pace you under
  the tier limit to avoid it. `retry-wire` adds opt-in throttling.
- **Not composable with non-SDK flows.** The moment your request shape leaves the
  SDK (custom streaming, batching, a mock in a test), the SDK's resilience doesn't
  come with it. `retry-wire` is transport-agnostic by design.

They are the right tool when you make every call through one official SDK and
never leave it. `retry-wire` is for everything else — and for keeping one retry
policy across SDKs, gateways, raw `fetch`, and streaming.

---

## The gap, in one line

| Capability | retry-wire | `p-retry` | `cockatiel` | `exponential-backoff` | `async-retry` | `ky` retry | openai / anthropic SDK |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Provider rate-limit rules (429 / 529 / 5xx) | Yes | By hand | By hand | By hand | By hand | Partial | Yes (own client) |
| Honors `Retry-After` / `retry-after-ms` | Yes | — | — | — | — | Partial | Yes |
| 529 overloaded distinct from quota 429 | Yes | — | — | — | — | — | Varies |
| Transport-agnostic (any `fetch` + any call) | Yes | Any promise | Any promise | Any promise | Any promise | `ky` only | — (welded) |
| Token-aware pacing (RPM / TPM) | Yes | — | Concurrency only | — | — | — | — |
| Abort cancels a pending backoff wait | Yes | Partial | Yes | — | Partial | Partial | n/a |
| Deterministic (injectable clock) | Yes | — | — | — | — | — | — |
| Zero runtime dependencies | Yes | Small deps | Yes | Yes | Small deps | — (in `ky`) | n/a |

`retry-wire` is the row that is provider-aware, transport-agnostic, and
token-aware pacing all at once — the exact shape an LLM API call needs, usable
with any client. Where a cell above says "Partial" or "By hand," the capability
is reachable but not built in; the hedges are deliberate because these projects
evolve. **Re-check each before quoting it.**
