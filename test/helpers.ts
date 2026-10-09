/** A deterministic clock: records every sleep and advances virtual time by it. */
export function fakeClock() {
  let t = 0;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal | null) => {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      delays.push(ms);
      t += ms;
    },
    delays,
    time: () => t,
  };
}

export function resp(status: number, headers: Record<string, string> = {}, body = "ok"): Response {
  return new Response(body, { status, headers });
}
