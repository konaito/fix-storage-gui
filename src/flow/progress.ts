import type { AiVerdict } from "../ai/provider";
import type { FinalVerdict } from "../safety/merge";
import { selectable } from "../safety/merge";

/** Phases reported by the Rust scanner (`scan-progress` events). */
export type ScanPhase = "listing" | "measuring" | "dates";
export const SCAN_PHASES: { id: ScanPhase; label: string }[] = [
  { id: "listing", label: "フォルダを一覧する" },
  { id: "measuring", label: "サイズを計測する" },
  { id: "dates", label: "最終使用日を取得する（Spotlight）" },
];

export type PhaseState = "done" | "active" | "pending";

/** Phase checklist state. `null` = nothing reported yet (the scan has just started listing). */
export function phaseStates(current: ScanPhase | null): Record<ScanPhase, PhaseState> {
  const order: ScanPhase[] = ["listing", "measuring", "dates"];
  const at = current ? order.indexOf(current) : 0;
  return Object.fromEntries(order.map((p, i) => [p, i < at ? "done" : i === at ? "active" : "pending"])) as Record<ScanPhase, PhaseState>;
}

/** done/total as 0..1, or null when the total is unknown (then show an indeterminate loader, never a made-up number). */
export function ratio(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

/** "12秒", "3分05秒". */
export function elapsedJa(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
}

export interface VerdictSummary {
  count: number;
  size: number;
}

export type Bucket = AiVerdict | "locked" | "pending";

/** Counts for the summary cards. Locked items (hard block / system) are their own bucket. */
export function summarize<T extends { size: number; final: FinalVerdict }>(rows: T[]): Record<Bucket | "all", VerdictSummary> {
  const out: Record<Bucket | "all", VerdictSummary> = {
    all: { count: 0, size: 0 },
    safe: { count: 0, size: 0 },
    caution: { count: 0, size: 0 },
    keep: { count: 0, size: 0 },
    locked: { count: 0, size: 0 },
    pending: { count: 0, size: 0 },
  };
  for (const r of rows) {
    const b = bucketOf(r.final);
    out[b].count++;
    out[b].size += r.size;
    out.all.count++;
    out.all.size += r.size;
  }
  return out;
}

export function bucketOf(f: FinalVerdict): Bucket {
  return f.locked ? "locked" : f.source === "pending" ? "pending" : f.verdict;
}

export type Filter = "all" | Bucket;

export function applyFilter<T extends { final: FinalVerdict }>(rows: T[], filter: Filter): T[] {
  return filter === "all" ? rows : rows.filter((r) => bucketOf(r.final) === filter);
}

/** Paths of every selectable "safe" row. Locked or "keep" rows are never included. */
export function safePaths<T extends { path: string; final: FinalVerdict }>(rows: T[]): string[] {
  return rows.filter((r) => selectable(r.final) && r.final.verdict === "safe").map((r) => r.path);
}
