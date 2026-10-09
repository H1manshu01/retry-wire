/**
 * retry-wire — provider-aware retry and throttle for LLM API calls.
 *
 * A tiny, zero-dependency wrapper around `fetch` or any async call that
 * understands OpenAI and Anthropic rate-limit semantics (429, 529 overloaded,
 * `Retry-After`, `x-ratelimit-*`) that generic retry libraries ignore.
 *
 * ```ts
 * import { retryFetch, withResilience } from "retry-wire";
 *
 * const rfetch = retryFetch(fetch, { provider: "openai", maxRetries: 5 });
 * const res = await rfetch(url, { method: "POST", body, signal });
 *
 * const out = await withResilience(
 *   (signal) => client.messages.create(params, { signal }),
 *   { provider: "anthropic", throttle: { rpm: 50, tpm: 40_000 } },
 * );
 * ```
 */
export { computeBackoff, retryFetch, withResilience } from "./core.js";
export {
  anthropicPack,
  defineRulePack,
  genericPack,
  openaiPack,
  parseRetryAfter,
  resolvePack,
} from "./rules.js";
export { Throttle } from "./throttle.js";
export type {
  BackoffOptions,
  Provider,
  RateLimitInfo,
  ResilienceOptions,
  RetryContext,
  RetryInfo,
  RulePack,
  ThrottleOptions,
} from "./types.js";
