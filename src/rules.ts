/**
 * Provider rule packs. Each knows which outcomes are retryable, how to read the
 * server's advised wait, and how to read remaining rate-limit budget.
 */
import type { Provider, RetryContext, RulePack } from "./types.js";

function num(headers: Headers, name: string): number | undefined {
  const v = headers.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an OpenAI-style duration header, e.g. "1s", "6m0s", "100ms", "1.5s". */
function parseDuration(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let ms = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: iterating regex matches
  while ((m = re.exec(v)) !== null) {
    matched = true;
    const n = Number.parseFloat(m[1] as string);
    const unit = m[2];
    ms += unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? ms : undefined;
}

function parseResetDate(v: string | null | undefined, now: number): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

/** Parse `retry-after-ms` (ms) or `Retry-After` (seconds or an HTTP date). */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms != null) {
    const n = Number(ms);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  const ra = headers.get("retry-after");
  if (ra == null) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(ra);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

const isNetworkError = (ctx: RetryContext): boolean =>
  ctx.status === undefined && ctx.error !== undefined;

const retryableStatus = (s?: number): boolean =>
  s === 408 || s === 409 || s === 429 || (s !== undefined && s >= 500 && s <= 599);

/** Generic HTTP resilience: network errors, 408/409/429, and 5xx. */
export const genericPack: RulePack = {
  name: "generic",
  isRetryable: (ctx) => isNetworkError(ctx) || retryableStatus(ctx.status),
  retryAfterMs: (h) => parseRetryAfter(h),
};

export const openaiPack: RulePack = {
  name: "openai",
  isRetryable: (ctx) => isNetworkError(ctx) || retryableStatus(ctx.status),
  retryAfterMs: (h) => parseRetryAfter(h),
  readLimits: (h) => ({
    requestsRemaining: num(h, "x-ratelimit-remaining-requests"),
    tokensRemaining: num(h, "x-ratelimit-remaining-tokens"),
    resetMs:
      parseDuration(h.get("x-ratelimit-reset-requests")) ??
      parseDuration(h.get("x-ratelimit-reset-tokens")),
  }),
};

export const anthropicPack: RulePack = {
  name: "anthropic",
  // 529 overloaded_error means the service is saturated — retry with backoff,
  // distinct from a quota 429.
  isRetryable: (ctx) => isNetworkError(ctx) || ctx.status === 529 || retryableStatus(ctx.status),
  retryAfterMs: (h) => parseRetryAfter(h),
  readLimits: (h) => ({
    requestsRemaining: num(h, "anthropic-ratelimit-requests-remaining"),
    tokensRemaining: num(h, "anthropic-ratelimit-tokens-remaining"),
    resetMs: parseResetDate(h.get("anthropic-ratelimit-requests-reset"), Date.now()),
  }),
};

const PACKS: Record<Provider, RulePack> = {
  generic: genericPack,
  openai: openaiPack,
  anthropic: anthropicPack,
};

export function resolvePack(p?: Provider | RulePack): RulePack {
  if (p === undefined) return genericPack;
  if (typeof p === "string") return PACKS[p] ?? genericPack;
  return p;
}

/** Identity helper for authoring a custom rule pack (for gateways, Bedrock/Vertex, etc.). */
export function defineRulePack(pack: RulePack): RulePack {
  return pack;
}
