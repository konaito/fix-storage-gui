import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONCURRENCY,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_RETRIES_AT_ONE,
  isRateLimitError,
  rateLimitBackoffMs,
  runBatches,
  type BatchProgress,
} from "../src/ai/runBatches";
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
  it("detects rate-limit, 429, and usage-limit SIWC errors", () => {
    expect(isRateLimitError(siwc({ kind: "rate_limited", message: "x", status: 429 }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "usage_limit", message: "x", code: "subscription_sharing_usage_limit_exceeded", status: 429 }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "api_error", message: "x", status: 429 }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "api_error", message: "x", code: "subscription_sharing_usage_limit_exceeded" }))).toBe(true);
    expect(isRateLimitError(siwc({ kind: "network", message: "x" }))).toBe(false);
    expect(isRateLimitError(new Error("boom"))).toBe(false);
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
      shouldStop: () => false,
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
      shouldStop: () => false,
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
      shouldStop: () => false,
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

  it("on stop, starts no new batches and lets in-flight ones finish", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let stop = false;
    const done = runBatches({
      batches: [0, 1, 2, 3, 4],
      itemCount: () => 1,
      concurrency: 2,
      send: async (_b, i) => {
        started.push(i);
        return gates[i].promise;
      },
      onBatchComplete: () => {},
      onProgress: () => {},
      shouldStop: () => stop,
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    stop = true;
    gates[0].resolve(0);
    gates[1].resolve(1);
    const result = await done;
    expect(started).toEqual([0, 1]);
    expect(result.stopped).toBe(true);
    expect(result.error).toBeNull();
    expect(result.batchesCompleted).toBe(2);
    expect(result.doneItems).toBe(2);
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
      shouldStop: () => false,
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
    const err = siwc({ kind: "usage_limit", message: "cap", status: 429, code: "subscription_sharing_usage_limit_exceeded" });
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
      shouldStop: () => false,
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
      shouldStop: () => false,
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
