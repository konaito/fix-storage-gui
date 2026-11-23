import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONCURRENCY,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_RETRIES_AT_ONE,
  isRateLimitError,
  isRetryableBatchError,
  isUsageLimitError,
  rateLimitBackoffMs,
  runBatches,
  type BatchProgress,
} from "../src/ai/runBatches";
import { JudgementParseError, parseJudgements } from "../src/ai/parse";
import type { SiwcError } from "../src/lib/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function siwc(partial: Partial<SiwcError> & Pick<SiwcError, "kind" | "message">): SiwcError {
  return { code: null, param: null, status: null, requestId: null, ...partial };
}

describe("isRateLimitError", () => {
  it("detects rate-limit and plain 429 SIWC errors, but not the usage limit (#27)", () => {
    expect(isRateLimitError(siwc({ kind: "rate_limited", message: "x", status: 429 }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "api_error", message: "x", status: 429 }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "usage_limit", message: "x", code: "subscription_sharing_usage_limit_exceeded", status: 429 }))).toBe(false);
    expect(isRateLimitError(siwc({ kind: "api_error", message: "x", code: "subscription_sharing_usage_limit_exceeded", status: 429 }))).toBe(false);
    expect(isRateLimitError(siwc({ kind: "network", message: "x" }))).toBe(false);
    expect(isRateLimitError(new Error("boom"))).toBe(false);
  });

  it("tells the usage limit and retryable batch errors apart", () => {
    expect(isUsageLimitError(siwc({ kind: "usage_limit", message: "x" }))).toBe(true);
    expect(isUsageLimitError(siwc({ kind: "api_error", message: "x", code: "subscription_sharing_usage_limit_exceeded" }))).toBe(true);
    expect(isUsageLimitError(siwc({ kind: "rate_limited", message: "x", status: 429 }))).toBe(false);
    expect(isRetryableBatchError(new JudgementParseError("x"))).toBe(true);
    expect(isRetryableBatchError(siwc({ kind: "interrupted", message: "x" }))).toBe(true);
    expect(isRetryableBatchError(siwc({ kind: "incomplete", message: "x" }))).toBe(true);
    expect(isRetryableBatchError(siwc({ kind: "ai_timeout", message: "x" }))).toBe(true);
    expect(isRetryableBatchError(siwc({ kind: "network", message: "x" }))).toBe(false);
    expect(isRetryableBatchError(new Error("boom"))).toBe(false);
  });
});

describe("runBatches", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs more batches than the concurrency cap", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<string>());
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const completed: number[] = [];

    const done = runBatches({
      batches: [0, 1, 2, 3, 4, 5],
      itemCount: () => 2,
      concurrency: 3,
      send: async (_b, i) => {
        started.push(i);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const value = await gates[i].promise;
        active -= 1;
        return value;
      },
      onBatchComplete: (i) => completed.push(i),
      onProgress: () => {},
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(maxActive).toBe(3);
    expect(DEFAULT_CONCURRENCY).toBe(3);

    gates[1].resolve("b");
    await vi.waitFor(() => expect(started.length).toBe(4));
    expect(completed).toEqual([1]);
    expect(started[3]).toBe(3);
    expect(maxActive).toBe(3);

    for (const i of [0, 2, 3, 4, 5]) gates[i].resolve(String(i));
    const result = await done;
    expect(result.error).toBeNull();
    expect(result.stopped).toBe(false);
    expect(result.batchesCompleted).toBe(6);
    expect(result.doneItems).toBe(12);
    expect(maxActive).toBe(3);
    expect(completed).toEqual([1, 0, 2, 3, 4, 5]);
  });

  it("merges results as each batch finishes, regardless of launch order", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const merged: string[] = [];
    const done = runBatches({
      batches: ["A", "B", "C"],
      itemCount: () => 1,
      concurrency: 3,
      send: (_b, i) => gates[i].promise,
      onBatchComplete: (_i, result) => merged.push(result),
      onProgress: () => {},
    });
    await vi.waitFor(() => expect(gates.every((g) => g.promise)).toBe(true));
    // Resolve out of order: C, then A, then B.
    gates[2].resolve("C");
    await vi.waitFor(() => expect(merged).toEqual(["C"]));
    gates[0].resolve("A");
    await vi.waitFor(() => expect(merged).toEqual(["C", "A"]));
    gates[1].resolve("B");
    const result = await done;
    expect(merged).toEqual(["C", "A", "B"]);
    expect(result.batchesCompleted).toBe(3);
  });

  it("sums streamed chars across in-flight requests and drops them when a batch finishes", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const report: { chars?: (n: number) => void }[] = [{}, {}];
    const snaps: BatchProgress[] = [];
    const done = runBatches({
      batches: [0, 1],
      itemCount: () => 1,
      concurrency: 2,
      send: async (_b, i, onChars) => {
        report[i].chars = onChars;
        await gates[i].promise;
      },
      onBatchComplete: () => {},
      onProgress: (p) => snaps.push({ ...p }),
    });
    await vi.waitFor(() => expect(report[0].chars && report[1].chars).toBeTruthy());
    report[0].chars!(10);
    report[1].chars!(25);
    await vi.waitFor(() => expect(snaps.at(-1)?.streamedChars).toBe(35));
    expect(snaps.at(-1)?.batchesInFlight).toBe(2);

    gates[0].resolve();
    await vi.waitFor(() => expect(snaps.at(-1)?.batchesCompleted).toBe(1));
    expect(snaps.at(-1)?.streamedChars).toBe(25);
    expect(snaps.at(-1)?.doneItems).toBe(1);
    expect(snaps.at(-1)?.batchesInFlight).toBe(1);

    gates[1].resolve();
    await done;
    expect(snaps.at(-1)?.streamedChars).toBe(0);
    expect(snaps.at(-1)?.doneItems).toBe(2);
    expect(snaps.at(-1)?.batchesInFlight).toBe(0);
  });

  it("on stop, starts no new batches, cancels the in-flight ones and returns without them (#21)", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const merged: number[] = [];
    const controller = new AbortController();
    const done = runBatches({
      batches: [0, 1, 2, 3, 4],
      itemCount: () => 1,
      concurrency: 2,
      send: async (_b, i, _onChars, signal) => {
        started.push(i);
        signals.push(signal);
        return gates[i].promise;
      },
      onBatchComplete: (i) => merged.push(i),
      onProgress: () => {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[0].resolve(0);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    controller.abort();
    const result = await done;
    // The sender sees the same signal, so it can cancel its request.
    expect(signals.every((s) => s.aborted)).toBe(true);
    gates[1].resolve(1);
    gates[2].resolve(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);
    expect(merged).toEqual([0]);
    expect(result.stopped).toBe(true);
    expect(result.error).toBeNull();
    expect(result.failed).toEqual([]);
    expect(result.batchesCompleted).toBe(1);
    expect(result.doneItems).toBe(1);
  });

  it("does not retry or count as failed a batch that errors because of the stop", async () => {
    const controller = new AbortController();
    const gate = deferred<string>();
    let sends = 0;
    const done = runBatches({
      batches: ["a"],
      itemCount: () => 1,
      concurrency: 1,
      send: async () => {
        sends += 1;
        return gate.promise;
      },
      onBatchComplete: () => {},
      onProgress: () => {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sends).toBe(1));
    controller.abort();
    gate.reject({ kind: "interrupted", message: "cancelled by us" });
    const result = await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("backs off and reduces concurrency on 429, then retries (fake timers)", async () => {
    vi.useFakeTimers();
    let failsLeft = 2;
    const conc: number[] = [];
    const done = runBatches({
      batches: ["only"],
      itemCount: () => 4,
      concurrency: 3,
      send: async () => {
        if (failsLeft > 0) {
          failsLeft -= 1;
          throw siwc({ kind: "rate_limited", message: "slow", status: 429 });
        }
        return "ok";
      },
      onBatchComplete: () => {},
      onProgress: (p) => conc.push(p.concurrency),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(failsLeft).toBe(1);
    expect(conc.at(-1)).toBe(2);

    await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(1));
    expect(failsLeft).toBe(0);
    expect(conc.at(-1)).toBe(1);

    await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(2));
    const result = await done;
    expect(result.error).toBeNull();
    expect(result.batchesCompleted).toBe(1);
    expect(result.doneItems).toBe(4);
    expect(Math.min(...conc)).toBe(1);
  });

  it("fails a rate-limited batch only after concurrency is 1 and retries are exhausted", async () => {
    vi.useFakeTimers();
    const err = siwc({ kind: "rate_limited", message: "slow", status: 429 });
    let sends = 0;
    const done = runBatches({
      batches: ["x"],
      itemCount: () => 1,
      concurrency: 1,
      send: async () => {
        sends += 1;
        throw err;
      },
      onBatchComplete: () => {},
      onProgress: () => {},
    });

    // Initial attempt + RATE_LIMIT_RETRIES_AT_ONE retries, each preceded by a backoff after the first failure.
    for (let i = 0; i < RATE_LIMIT_RETRIES_AT_ONE; i++) {
      await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(i + 1));
    }
    // One more tick so the last failure is observed without another successful retry.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_BACKOFF_MS);
    const result = await done;
    expect(result.error).toBe(err);
    expect(result.batchesCompleted).toBe(0);
    expect(sends).toBe(1 + RATE_LIMIT_RETRIES_AT_ONE);
  });

  it("stops launching new batches on a non-rate-limit error and keeps results already received", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<string>());
    const started: number[] = [];
    const merged: string[] = [];
    const boom = new Error("nope");
    const done = runBatches({
      batches: ["a", "b", "c", "d", "e"],
      itemCount: () => 1,
      concurrency: 3,
      send: async (b, i) => {
        started.push(i);
        if (b === "b") {
          await gates[i].promise;
          throw boom;
        }
        return gates[i].promise;
      },
      onBatchComplete: (_i, result) => merged.push(result),
      onProgress: () => {},
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    // Fail while the other in-flight batches are still running, so a free slot cannot
    // start the next queued batch before stopLaunching flips.
    gates[1].resolve("ignored");
    gates[0].resolve("a");
    gates[2].resolve("c");
    const result = await done;
    expect(result.error).toBe(boom);
    expect(result.stopped).toBe(false);
    expect(started).toEqual([0, 1, 2]);
    expect([...merged].sort()).toEqual(["a", "c"]);
    expect(result.batchesCompleted).toBe(2);
    expect(result.doneItems).toBe(2);
  });
});

describe("runBatches: stop, per-batch retry and usage limit (#21, #27)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns right away on stop without waiting for a batch that never answers (#21)", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const merged: number[] = [];
    const late = deferred<number>();
    const done = runBatches({
      batches: [0, 1, 2],
      itemCount: () => 1,
      concurrency: 2,
      send: (_b, i) => {
        started.push(i);
        // Batch 0 never answers; batch 1 answers only after the stop.
        return i === 0 ? new Promise<number>(() => {}) : late.promise;
      },
      onBatchComplete: (i) => merged.push(i),
      onProgress: () => {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    controller.abort();
    const result = await Promise.race([done, new Promise<"pending">((r) => setTimeout(() => r("pending"), 200))]);
    expect(result).not.toBe("pending");
    if (result === "pending") return;
    expect(result.stopped).toBe(true);
    expect(result.error).toBeNull();
    // A late answer after the stop is not merged.
    late.resolve(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(merged).toEqual([]);
    expect(started).toEqual([0, 1]);
  });

  it("retries a batch once on a parse error and keeps sending the others (#27)", async () => {
    const sends: number[] = [];
    const merged: number[] = [];
    const done = runBatches({
      batches: [0, 1, 2, 3],
      itemCount: () => 2,
      concurrency: 1,
      send: async (_b, i) => {
        sends.push(i);
        if (i === 1) return parseJudgements("sorry, no JSON", new Set(["i0"]));
        return [];
      },
      onBatchComplete: (i) => merged.push(i),
      onProgress: () => {},
    });
    const result = (await done) as Awaited<typeof done> & { failed?: { index: number }[] };
    expect(sends).toEqual([0, 1, 1, 2, 3]);
    expect(merged).toEqual([0, 2, 3]);
    expect(result.error).toBeNull();
    expect(result.failed?.map((f) => f.index)).toEqual([1]);
    expect(result.doneItems).toBe(6);
  });

  it("retries an interrupted or incomplete batch once and uses the retry's answer (#27)", async () => {
    for (const kind of ["interrupted", "incomplete"]) {
      let calls = 0;
      const merged: string[] = [];
      const result = await runBatches({
        batches: ["a", "b"],
        itemCount: () => 1,
        concurrency: 1,
        send: async (b) => {
          calls += 1;
          if (b === "a" && calls === 1) throw siwc({ kind, message: "cut" });
          return b;
        },
        onBatchComplete: (_i, r) => merged.push(r),
        onProgress: () => {},
      });
      expect(calls).toBe(3);
      expect(merged).toEqual(["a", "b"]);
      expect(result.error).toBeNull();
      expect(result.batchesCompleted).toBe(2);
    }
  });

  it("stops sending on usage_limit right away, without waiting or resending (#27)", async () => {
    vi.useFakeTimers();
    const err = siwc({ kind: "usage_limit", message: "cap", status: 429, code: "subscription_sharing_usage_limit_exceeded" });
    let sends = 0;
    const done = runBatches({
      batches: [0, 1, 2, 3, 4, 5],
      itemCount: () => 1,
      concurrency: 3,
      send: async () => {
        sends += 1;
        throw err;
      },
      onBatchComplete: () => {},
      onProgress: () => {},
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await done;
    expect(result.error).toBe(err);
    // Only the three already in flight were sent; nothing after the first usage_limit.
    expect(sends).toBe(3);
    expect(isRateLimitError(err)).toBe(false);
  });
});
