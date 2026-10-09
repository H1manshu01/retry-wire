# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-09

Initial public release — provider-aware retry and throttle for LLM API calls: a
zero-dependency wrapper around `fetch` or any async call that understands the
429s, 529 overloads, and `Retry-After` headers that generic retry libraries
ignore.

### Added
- **`withResilience<T>(op, options?)`** — wraps any async operation (an SDK
  method, a custom client) and retries on **thrown** errors (SDK errors, network
  failures) per the provider rule pack. Forwards an `AbortSignal` to `op`, reads
  the thrown error's `status` / `statusCode` / `response.status` and headers, and
  re-throws non-retryable errors and aborts unchanged.
- **`retryFetch(fetch?, options?)`** — a drop-in `fetch` wrapper that retries on
  **retryable responses** (429, 529, 5xx, 408/409) and network errors, honors
  `Retry-After` / `retry-after-ms`, and drains the response body before retrying.
  `fetch` defaults to `globalThis.fetch`. Returns non-retryable responses as-is,
  never throwing on an HTTP status.
- **`computeBackoff(attempt, backoff)`** — the backoff curve: base
  `min(initial * factor ** attempt, max)` with `"full"` (default), `"equal"`, or
  `"none"` jitter.
- **Provider rule packs** — `genericPack` (network + 408/409/429/5xx),
  `openaiPack` (+ `x-ratelimit-*` and `x-ratelimit-reset-*` duration parsing),
  and `anthropicPack` (+ 529 `overloaded_error` as retryable, distinct from a
  quota 429, + `anthropic-ratelimit-*`). Plus `defineRulePack(pack)`,
  `resolvePack(provider?)`, and `parseRetryAfter(headers, now?)` (reads
  `retry-after-ms`, then `Retry-After` as seconds or an HTTP date).
- **`Throttle`** — a token-bucket limiter over RPM and TPM for opt-in,
  client-side pacing under tier limits. `rpm` paces both wrappers; `tpm` +
  `estimateTokens(input, init)` pace `retryFetch`.
- **`ResilienceOptions`** — `provider` (default `"generic"`), `maxRetries`
  (default `3`), `backoff` (default `{ initial: 500, max: 60000, factor: 2,
  jitter: "full" }`), `respectRetryAfter` (default `true`), `idempotent`
  (default `true` — non-idempotent calls are never retried), `throttle`,
  `signal`, `onRetry`, and the injectable `now` / `sleep`.
- **Abort semantics:** an abort cancels the in-flight call **and** any pending
  backoff or throttle wait, rejecting with the abort reason; an already-aborted
  signal throws before the first attempt.
- **Exported types:** `ResilienceOptions`, `RulePack`, `RetryContext`,
  `RateLimitInfo`, `BackoffOptions`, `ThrottleOptions`, `RetryInfo`, `Provider`.

### Verified
- `computeBackoff` is exponential, respects the cap, and keeps full-jitter in
  `[0, base]` and equal-jitter in `[base/2, base]`.
- `withResilience` retries then succeeds (recording exponential delays), honors
  `Retry-After` over the curve, gives up after `maxRetries` and throws the last
  error, does not retry a 400 or when `idempotent` is `false`, retries an
  Anthropic 529, propagates an abort during the retry wait, and throws
  immediately for an already-aborted signal.
- `retryFetch` retries a 429 honoring `Retry-After`, returns a non-retryable 400
  as-is, retries a network error, and gives up after `maxRetries` returning the
  last response.
- Rule packs: `parseRetryAfter` reads the ms header, seconds, and an HTTP date;
  `isRetryable` matrices for generic and anthropic; OpenAI and Anthropic
  `readLimits`; and `resolvePack` name / pack / undefined resolution.
- `Throttle` paces RPM (full bucket, then at the refill rate) and TPM (on token
  cost).
- 25 tests pass. ESM + CJS builds with type declarations; zero-dependency, under
  the `size-limit` budget (~1.68 kB min+brotli).

[0.1.0]: https://github.com/H1manshu01/retry-wire/releases/tag/v0.1.0
