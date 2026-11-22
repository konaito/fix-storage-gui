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

export const DEFAULT_CONCURRENCY = 3;

/** Base delay for rate-limit backoff (ms). Doubles each attempt, then caps. */
export const RATE_LIMIT_BACKOFF_MS = 1000;
const BACKOFF_CAP_MS = 8000;

/** Extra retries of a batch after concurrency has already been reduced to 1. */
export const RATE_LIMIT_RETRIES_AT_ONE = 2;

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
  send: (batch: T, index: number, onChars: (chars: number) => void) => Promise<R>;
  /** Called as soon as a batch succeeds, regardless of launch order. */
  onBatchComplete: (index: number, result: R, batch: T) => void;
  onProgress: (progress: BatchProgress) => void;
  shouldStop: () => boolean;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  isRateLimitError?: (error: unknown) => boolean;
  rateLimitRetriesAtOne?: number;
}

export interface RunBatchesResult {
  stopped: boolean;
  error: unknown | null;
  batchesCompleted: number;
  doneItems: number;
}

/** Rate-limit / 429 / ChatGPT-plan usage-limit errors that trigger backoff. */
export function isRateLimitError(error: unknown): boolean {
  if (isSiwcError(error)) {
    if (error.kind === "rate_limited" || error.kind === "usage_limit") return true;
    if (error.status === 429) return true;
    if (error.code === "subscription_sharing_usage_limit_exceeded") return true;
  }
  return false;
}

export async function runBatches<T, R>(opts: RunBatchesOptions<T, R>): Promise<RunBatchesResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isRl = opts.isRateLimitError ?? isRateLimitError;
  const retriesAtOne = opts.rateLimitRetriesAtOne ?? RATE_LIMIT_RETRIES_AT_ONE;
  const batches = opts.batches;
  const totalBatches = batches.length;
  const totalItems = batches.reduce((n, b) => n + opts.itemCount(b), 0);

  let concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let stopLaunching = false;
  let stopped = false;
  let error: unknown | null = null;
  let doneItems = 0;
  let batchesCompleted = 0;
  let nextAttempt = 1;

  const queue: number[] = batches.map((_, i) => i);
  const inFlightChars = new Map<number, number>();
  const retriesAtFloor = new Map<number, number>();
  const running = new Set<Promise<void>>();

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

  const emit = () => opts.onProgress(progress());
  emit();

  const canLaunch = () =>
    !stopLaunching && !opts.shouldStop() && inFlightChars.size < concurrency && queue.length > 0;

  const launch = async (index: number): Promise<void> => {
    const batch = batches[index];
    inFlightChars.set(index, 0);
    emit();
    try {
      const result = await opts.send(batch, index, (chars) => {
        if (inFlightChars.has(index)) {
          inFlightChars.set(index, chars);
          emit();
        }
      });
      inFlightChars.delete(index);
      doneItems += opts.itemCount(batch);
      batchesCompleted += 1;
      opts.onBatchComplete(index, result, batch);
      emit();
    } catch (e) {
      inFlightChars.delete(index);
      emit();
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
        if (opts.shouldStop()) {
          stopped = true;
          stopLaunching = true;
          emit();
          return;
        }
        if (error) return;
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
    if (opts.shouldStop()) {
      stopped = true;
      stopLaunching = true;
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
    await Promise.race(running);
  }

  return { stopped, error, batchesCompleted, doneItems };
}
