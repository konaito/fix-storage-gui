/**
 * Runs AI judgement batches with a concurrency cap.
 *
 * Official Sign in with ChatGPT docs (models-and-inference, preview-limitations,
 * errors-and-recovery) do not state a request-concurrency or RPM/TPM limit.
 * They document usage-based limits (Plus users share a five-hour allowance
 * across apps) and say to pause new requests on HTTP 429
 * `subscription_sharing_usage_limit_exceeded`. The default of 3 is a
 * conservative choice we made; it is not a documented cap.
 */
import { isSiwcError } from "../lib/api";
import { JudgementParseError } from "./parse";

export const DEFAULT_CONCURRENCY = 3;

/** Base delay for rate-limit backoff (ms). Doubles each attempt, then caps. */
export const RATE_LIMIT_BACKOFF_MS = 1000;
const BACKOFF_CAP_MS = 8000;

/** Extra retries of a batch after concurrency has already been reduced to 1. */
export const RATE_LIMIT_RETRIES_AT_ONE = 2;

/** Extra attempts for a batch whose reply was cut off or unreadable (#27). */
export const BATCH_RETRIES = 1;

export function rateLimitBackoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(BACKOFF_CAP_MS, RATE_LIMIT_BACKOFF_MS * 2 ** (n - 1));
}

export interface BatchProgress {
  doneItems: number;
  totalItems: number;
  batchesInFlight: number;
  batchesCompleted: number;
  batchesTotal: number;
  /** Sum of streamed character counts across currently in-flight requests. */
  streamedChars: number;
  concurrency: number;
}

export interface RunBatchesOptions<T, R> {
  batches: T[];
  itemCount: (batch: T) => number;
  /** `signal` is the run's stop signal; a sender can use it to cancel its request. */
  send: (batch: T, index: number, onChars: (chars: number) => void, signal: AbortSignal) => Promise<R>;
  /** Called as soon as a batch succeeds, regardless of launch order. Never called after runBatches has returned. */
  onBatchComplete: (index: number, result: R, batch: T) => void;
  onProgress: (progress: BatchProgress) => void;
  /**
   * Stop. runBatches returns right away without waiting for batches in flight (#21);
   * their late answers are dropped.
   */
  signal?: AbortSignal;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  isRateLimitError?: (error: unknown) => boolean;
  rateLimitRetriesAtOne?: number;
}

export interface FailedBatch {
  index: number;
  error: unknown;
}

export interface RunBatchesResult {
  stopped: boolean;
  /** An error that stopped the whole run (no new batches were sent after it). */
  error: unknown | null;
  /** Batches that still failed after their retry. The others kept going; these items stay unjudged. */
  failed: FailedBatch[];
  batchesCompleted: number;
  doneItems: number;
}

/** The ChatGPT plan's usage limit. Waiting a few seconds does not help, so the run stops at once (#27). */
export function isUsageLimitError(error: unknown): boolean {
  return isSiwcError(error) && (error.kind === "usage_limit" || error.code === "subscription_sharing_usage_limit_exceeded");
}

/** Plain 429 rate limiting: back off and resend. The usage limit also comes as a 429 but is not one of these. */
export function isRateLimitError(error: unknown): boolean {
  if (!isSiwcError(error) || isUsageLimitError(error)) return false;
  return error.kind === "rate_limited" || error.status === 429;
}

/** A reply that was cut off, timed out or could not be read: worth one more try of the same batch. */
export function isRetryableBatchError(error: unknown): boolean {
  if (error instanceof JudgementParseError) return true;
  return isSiwcError(error) && (error.kind === "interrupted" || error.kind === "incomplete" || error.kind === "ai_timeout");
}

export async function runBatches<T, R>(opts: RunBatchesOptions<T, R>): Promise<RunBatchesResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isRl = opts.isRateLimitError ?? isRateLimitError;
  const retriesAtOne = opts.rateLimitRetriesAtOne ?? RATE_LIMIT_RETRIES_AT_ONE;
  const batches = opts.batches;
  const totalBatches = batches.length;
  const totalItems = batches.reduce((n, b) => n + opts.itemCount(b), 0);

  const signal = opts.signal ?? new AbortController().signal;

  let concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let stopLaunching = false;
  let stopped = false;
  /** Set when runBatches returns; anything that settles later is ignored. */
  let finished = false;
  let error: unknown | null = null;
  const failed: FailedBatch[] = [];
  let doneItems = 0;
  let batchesCompleted = 0;
  let nextAttempt = 1;

  const queue: number[] = batches.map((_, i) => i);
  const inFlightChars = new Map<number, number>();
  const retriesAtFloor = new Map<number, number>();
  const retried = new Map<number, number>();
  const running = new Set<Promise<void>>();
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  const progress = (): BatchProgress => {
    let streamedChars = 0;
    for (const c of inFlightChars.values()) streamedChars += c;
    return {
      doneItems,
      totalItems,
      batchesInFlight: inFlightChars.size,
      batchesCompleted,
      batchesTotal: totalBatches,
      streamedChars,
      concurrency,
    };
  };

  const emit = () => {
    if (!finished) opts.onProgress(progress());
  };
  emit();

  const canLaunch = () => !stopLaunching && !signal.aborted && inFlightChars.size < concurrency && queue.length > 0;

  const launch = async (index: number): Promise<void> => {
    const batch = batches[index];
    inFlightChars.set(index, 0);
    emit();
    try {
      const result = await opts.send(
        batch,
        index,
        (chars) => {
          if (inFlightChars.has(index)) {
            inFlightChars.set(index, chars);
            emit();
          }
        },
        signal,
      );
      if (finished) return;
      inFlightChars.delete(index);
      doneItems += opts.itemCount(batch);
      batchesCompleted += 1;
      opts.onBatchComplete(index, result, batch);
      emit();
    } catch (e) {
      // After a stop, the failure is usually our own cancel: neither a retry nor a failed batch.
      if (finished || signal.aborted) return;
      inFlightChars.delete(index);
      emit();
      if (isRetryableBatchError(e)) {
        const n = retried.get(index) ?? 0;
        if (n < BATCH_RETRIES) {
          retried.set(index, n + 1);
          queue.unshift(index);
        } else {
          failed.push({ index, error: e });
        }
        emit();
        return;
      }
      if (isRl(e)) {
        const prev = concurrency;
        concurrency = Math.max(1, concurrency - 1);
        const atFloor = prev === 1 && concurrency === 1;
        if (atFloor) {
          const n = (retriesAtFloor.get(index) ?? 0) + 1;
          retriesAtFloor.set(index, n);
          if (n > retriesAtOne) {
            error = e;
            stopLaunching = true;
            emit();
            return;
          }
        }
        emit();
        const delay = rateLimitBackoffMs(nextAttempt);
        nextAttempt += 1;
        await sleep(delay);
        if (finished || signal.aborted || error) return;
        queue.unshift(index);
        emit();
        return;
      }
      error = e;
      stopLaunching = true;
      emit();
    }
  };

  while (true) {
    if (signal.aborted) {
      // Do not wait for batches in flight: a stalled stream must not keep the app busy (#21).
      stopped = true;
      break;
    }
    while (canLaunch()) {
      const index = queue.shift()!;
      let task!: Promise<void>;
      task = launch(index).finally(() => {
        running.delete(task);
      });
      running.add(task);
    }
    if (running.size === 0) break;
    await Promise.race([...running, aborted]);
  }

  finished = true;
  return { stopped, error, failed, batchesCompleted, doneItems };
}
