/**
 * retry-wire — the retry engine.
 *
 * `withResilience` wraps any async operation (an SDK method, a custom client);
 * `retryFetch` is a drop-in `fetch` wrapper. Both carry provider rate-limit
 * knowledge via a {@link RulePack} and are transport-agnostic and abort-aware.
 */
import { resolvePack } from "./rules.js";
import { Throttle } from "./throttle.js";
import type { BackoffOptions, ResilienceOptions, RetryContext } from "./types.js";

function abortError(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isAbort(err: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

function realSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Compute the backoff delay (ms) for a 0-based attempt. */
export function computeBackoff(attempt: number, opts: Required<BackoffOptions>): number {
  const base = Math.min(opts.initial * opts.factor ** attempt, opts.max);
  switch (opts.jitter) {
    case "none":
      return base;
    case "equal":
      return base / 2 + Math.random() * (base / 2);
    default:
      return Math.random() * base;
  }
}

function asHeaders(h: unknown): Headers | undefined {
  if (!h) return undefined;
  if (h instanceof Headers) return h;
  try {
    return new Headers(h as Record<string, string>);
  } catch {
    return undefined;
  }
}

/** Extract a retry context from a thrown error (SDK error, network failure). */
function toContext(err: unknown): RetryContext {
  const e = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; headers?: unknown };
    headers?: unknown;
    error?: unknown;
    body?: unknown;
  };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.statusCode === "number"
        ? e.statusCode
        : typeof e?.response?.status === "number"
          ? e.response.status
          : undefined;
  return {
    status,
    headers: asHeaders(e?.headers ?? e?.response?.headers),
    error: err,
    body: e?.error ?? e?.body,
  };
}

interface NormConfig {
  maxRetries: number;
  backoff: Required<BackoffOptions>;
  respectRetryAfter: boolean;
  idempotent: boolean;
  throttle?: Throttle;
  signal: AbortSignal | null;
  onRetry?: ResilienceOptions["onRetry"];
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

function normalize(o: ResilienceOptions): NormConfig {
  const now = o.now ?? Date.now;
  return {
    maxRetries: o.maxRetries ?? 3,
    backoff: {
      initial: o.backoff?.initial ?? 500,
      max: o.backoff?.max ?? 60_000,
      factor: o.backoff?.factor ?? 2,
      jitter: o.backoff?.jitter ?? "full",
    },
    respectRetryAfter: o.respectRetryAfter ?? true,
    idempotent: o.idempotent ?? true,
    throttle: o.throttle ? new Throttle(o.throttle, now()) : undefined,
    signal: o.signal ?? null,
    onRetry: o.onRetry,
    now,
    sleep: o.sleep ?? realSleep,
  };
}

function reasonOf(ctx: RetryContext): string {
  return ctx.status !== undefined ? `HTTP ${ctx.status}` : "network error";
}

/**
 * Run an async operation with provider-aware retries and optional throttling.
 *
 * ```ts
 * const res = await withResilience(
 *   (signal) => client.messages.create(params, { signal }),
 *   { provider: "anthropic", maxRetries: 5 },
 * );
 * ```
 */
export async function withResilience<T>(
  op: (signal?: AbortSignal) => Promise<T> | T,
  options: ResilienceOptions = {},
): Promise<T> {
  const cfg = normalize(options);
  const pack = resolvePack(options.provider);
  let attempt = 0;
  for (;;) {
    if (cfg.signal?.aborted) throw abortError(cfg.signal);
    if (cfg.throttle) await cfg.throttle.acquire(0, cfg.now, cfg.sleep, cfg.signal);
    try {
      return await op(cfg.signal ?? undefined);
    } catch (err) {
      if (isAbort(err, cfg.signal)) throw err;
      const ctx = toContext(err);
      if (!cfg.idempotent || attempt >= cfg.maxRetries || !pack.isRetryable(ctx)) throw err;
      const advised =
        cfg.respectRetryAfter && ctx.headers ? pack.retryAfterMs(ctx.headers) : undefined;
      const delay = advised ?? computeBackoff(attempt, cfg.backoff);
      attempt++;
      cfg.onRetry?.({ attempt, delayMs: delay, reason: reasonOf(ctx), status: ctx.status });
      await cfg.sleep(delay, cfg.signal);
    }
  }
}

/**
 * Wrap a `fetch` so requests retry on retryable responses (429, 529, 5xx, ...)
 * and network errors, honoring `Retry-After`. Transport-agnostic; composes with
 * streaming clients (e.g. sse-wire).
 *
 * ```ts
 * const rfetch = retryFetch(fetch, { provider: "openai", maxRetries: 5 });
 * const res = await rfetch(url, { method: "POST", body, signal });
 * ```
 */
export function retryFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: ResilienceOptions = {},
): typeof fetch {
  const cfg = normalize(options);
  const pack = resolvePack(options.provider);
  const estimate = options.throttle?.estimateTokens;

  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const signal = init?.signal ?? cfg.signal ?? undefined;
    const tokenCost = cfg.throttle && estimate ? estimate(input, init) : 1;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      if (cfg.throttle) await cfg.throttle.acquire(tokenCost, cfg.now, cfg.sleep, signal);

      let response: Response | undefined;
      try {
        response = await fetchImpl(input, init);
      } catch (err) {
        if (
          isAbort(err, signal) ||
          !cfg.idempotent ||
          attempt >= cfg.maxRetries ||
          !pack.isRetryable({ error: err })
        ) {
          throw err;
        }
        const delay = computeBackoff(attempt, cfg.backoff);
        attempt++;
        cfg.onRetry?.({ attempt, delayMs: delay, reason: "network error" });
        await cfg.sleep(delay, signal);
        continue;
      }

      if (
        !cfg.idempotent ||
        attempt >= cfg.maxRetries ||
        !pack.isRetryable({ status: response.status, headers: response.headers })
      ) {
        return response;
      }
      const advised = cfg.respectRetryAfter ? pack.retryAfterMs(response.headers) : undefined;
      const delay = advised ?? computeBackoff(attempt, cfg.backoff);
      attempt++;
      cfg.onRetry?.({
        attempt,
        delayMs: delay,
        reason: `HTTP ${response.status}`,
        status: response.status,
      });
      // Release the connection before sleeping and retrying.
      await response.body?.cancel().catch(() => {});
      await cfg.sleep(delay, signal);
    }
  };

  return wrapped as typeof fetch;
}
