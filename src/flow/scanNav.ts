import type { Target } from "../components/steps/TargetStep";

/** How a scan changes the "上のフォルダへ" history: drill in (push), go up (pop), start over (reset), rescan (keep). */
export type HistoryOp = "push" | "pop" | "reset" | "keep";

export interface ScanNav {
  /** The choice on the target step. */
  target: Target;
  /** What the list on screen is of. */
  scanned: Target;
  /** Where "上のフォルダへ" goes back to, last first. */
  history: Target[];
}

/**
 * Target, list target and history once a scan of `attempted` ends (#37).
 * Only a successful scan changes the history. A failed one goes back to the list on screen if there is one
 * (`hadScan`), otherwise it keeps what the user chose.
 */
export function afterScan(nav: ScanNav, attempted: Target, op: HistoryOp, ok: boolean, hadScan: boolean): ScanNav {
  if (!ok) return { ...nav, target: hadScan ? nav.scanned : attempted };
  const history =
    op === "push" ? [...nav.history, nav.scanned] : op === "pop" ? nav.history.slice(0, -1) : op === "reset" ? [] : nav.history;
  return { target: attempted, scanned: attempted, history };
}
