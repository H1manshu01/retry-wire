import { describe, expect, it } from "vitest";
import {
  anthropicPack,
  genericPack,
  openaiPack,
  parseRetryAfter,
  resolvePack,
} from "../src/index.js";

const h = (o: Record<string, string>) => new Headers(o);

describe("parseRetryAfter", () => {
  it("reads retry-after-ms (ms)", () => {
    expect(parseRetryAfter(h({ "retry-after-ms": "1500" }))).toBe(1500);
  });
  it("reads Retry-After as seconds", () => {
    expect(parseRetryAfter(h({ "retry-after": "2" }))).toBe(2000);
  });
  it("reads Retry-After as an HTTP date", () => {
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfter(h({ "retry-after": future }), now);
    expect(ms).toBeGreaterThanOrEqual(4000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it("returns undefined when absent", () => {
    expect(parseRetryAfter(h({}))).toBeUndefined();
  });
});

describe("isRetryable", () => {
  it("generic retries 408/409/429/5xx and network errors, not 2xx/4xx", () => {
    for (const s of [408, 409, 429, 500, 503, 529]) {
      expect(genericPack.isRetryable({ status: s })).toBe(true);
    }
    expect(genericPack.isRetryable({ status: 400 })).toBe(false);
    expect(genericPack.isRetryable({ status: 200 })).toBe(false);
    expect(genericPack.isRetryable({ error: new Error("ECONNRESET") })).toBe(true);
  });
  it("anthropic retries 529 overloaded", () => {
    expect(anthropicPack.isRetryable({ status: 529 })).toBe(true);
    expect(anthropicPack.isRetryable({ status: 400 })).toBe(false);
  });
});

describe("readLimits", () => {
  it("parses OpenAI x-ratelimit headers and durations", () => {
    const info = openaiPack.readLimits?.(
      h({
        "x-ratelimit-remaining-requests": "42",
        "x-ratelimit-remaining-tokens": "9000",
        "x-ratelimit-reset-requests": "6m0s",
      }),
    );
    expect(info).toMatchObject({ requestsRemaining: 42, tokensRemaining: 9000, resetMs: 360_000 });
  });
  it("parses Anthropic ratelimit headers", () => {
    const info = anthropicPack.readLimits?.(
      h({
        "anthropic-ratelimit-requests-remaining": "7",
        "anthropic-ratelimit-tokens-remaining": "100",
      }),
    );
    expect(info).toMatchObject({ requestsRemaining: 7, tokensRemaining: 100 });
  });
});

describe("resolvePack", () => {
  it("resolves names and passes through a custom pack", () => {
    expect(resolvePack("openai")).toBe(openaiPack);
    expect(resolvePack("anthropic")).toBe(anthropicPack);
    expect(resolvePack()).toBe(genericPack);
    const custom = { isRetryable: () => true, retryAfterMs: () => undefined };
    expect(resolvePack(custom)).toBe(custom);
  });
});
