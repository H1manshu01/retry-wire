/**
 * Optional client-side pacing: token buckets over requests-per-minute and
 * tokens-per-minute, so you stay under a tier's limits and avoid the 429 rather
 * than only reacting to it.
 */
import type { ThrottleOptions } from "./types.js";

type Sleep = (ms: number, signal?: AbortSignal | null) => Promise<void>;

class Bucket {
  private tokens: number;
  private last: number;
  private readonly perMs: number;

  constructor(
    private readonly capacity: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
    this.perMs = capacity / 60_000;
  }

  async take(
    cost: number,
    now: () => number,
    sleep: Sleep,
    signal?: AbortSignal | null,
  ): Promise<void> {
    // A single request can never need more than one full window's worth.
    const need = Math.min(cost, this.capacity);
    for (;;) {
      const t = now();
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.perMs);
      this.last = t;
      if (this.tokens >= need) {
        this.tokens -= need;
        return;
      }
      const waitMs = Math.ceil((need - this.tokens) / this.perMs);
      await sleep(waitMs, signal);
    }
  }
}

export class Throttle {
  private readonly rpm?: Bucket;
  private readonly tpm?: Bucket;

  constructor(opts: ThrottleOptions, now: number) {
    if (opts.rpm && opts.rpm > 0) this.rpm = new Bucket(opts.rpm, now);
    if (opts.tpm && opts.tpm > 0) this.tpm = new Bucket(opts.tpm, now);
  }

  async acquire(
    tokenCost: number,
    now: () => number,
    sleep: Sleep,
    signal?: AbortSignal | null,
  ): Promise<void> {
    if (this.rpm) await this.rpm.take(1, now, sleep, signal);
    if (this.tpm && tokenCost > 0) await this.tpm.take(tokenCost, now, sleep, signal);
  }
}
