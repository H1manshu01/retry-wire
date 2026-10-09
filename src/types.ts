/** What a rule pack inspects to decide whether and how to retry. */
export interface RetryContext {
  /** HTTP status, when there is a response. */
  status?: number;
  /** The thrown error, when the call rejected (e.g. a network failure or an SDK error). */
  error?: unknown;
  /** Parsed error body, if available. */
  body?: unknown;
  /** Response (or error) headers, if available. */
  headers?: Headers;
}

export interface RateLimitInfo {
  requestsRemaining?: number;
  tokensRemaining?: number;
  /** Milliseconds until the limit resets. */
  resetMs?: number;
}

/** Provider-specific retry rules. Data, not hardcoded — swap or extend freely. */
export interface RulePack {
  name?: string;
  /** Is this outcome worth retrying? */
  isRetryable(ctx: RetryContext): boolean;
  /** The server-advised wait, in ms, from `Retry-After` / `retry-after-ms`, if any. */
  retryAfterMs(headers: Headers): number | undefined;
  /** Read remaining request/token budget from rate-limit headers, if present. */
  readLimits?(headers: Headers): RateLimitInfo;
}

export interface BackoffOptions {
  /** First delay, in ms. Default 500. */
  initial?: number;
  /** Ceiling for the delay, in ms. Default 60000. */
  max?: number;
  /** Exponential factor. Default 2. */
  factor?: number;
  /** Jitter strategy. Default "full". */
  jitter?: "full" | "equal" | "none";
}

export interface ThrottleOptions {
  /** Requests per minute. */
  rpm?: number;
  /** Tokens per minute. */
  tpm?: number;
  /** Estimate the token cost of a request (for TPM pacing in `retryFetch`). */
  estimateTokens?: (input: unknown, init?: unknown) => number;
}

export interface RetryInfo {
  /** 1-based retry attempt number. */
  attempt: number;
  /** The delay before this retry, in ms. */
  delayMs: number;
  /** Why the retry is happening. */
  reason: string;
  status?: number;
}

export type Provider = "openai" | "anthropic" | "generic";

export interface ResilienceOptions {
  /** A built-in provider pack name, or a custom {@link RulePack}. Default "generic". */
  provider?: Provider | RulePack;
  /** Max retries after the first attempt. Default 3. */
  maxRetries?: number;
  backoff?: BackoffOptions;
  /** Honor `Retry-After` / `retry-after-ms` headers. Default true. */
  respectRetryAfter?: boolean;
  /**
   * Whether the wrapped call is safe to retry. Default true — LLM completions
   * have no side effects. Set false for calls that mutate server state.
   */
  idempotent?: boolean;
  /** Opt-in client-side pacing to stay under RPM/TPM tier limits. */
  throttle?: ThrottleOptions;
  signal?: AbortSignal | null;
  /** Called before each retry sleep. */
  onRetry?: (info: RetryInfo) => void;
  /** Advanced/testing: injectable clock. Default `Date.now`. */
  now?: () => number;
  /** Advanced/testing: injectable sleep. Default a real, abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}
