import { classify, type Label } from "../cli-core/classify";
import type { AiJudgement } from "../ai/provider";
import { mergeVerdict, type FinalVerdict } from "../safety/merge";
import type { ScanItem } from "./api";

export interface Row extends ScanItem {
  cli: Label;
  ai?: AiJudgement;
  final: FinalVerdict;
}

/** Runs fix-storage's own classify() (vendored, unchanged) on a scanned item. */
export function cliLabel(item: ScanItem, now = Date.now()): Label {
  const usage =
    item.lastUsedMs != null
      ? { at: item.lastUsedMs, kind: "opened" as const }
      : item.modifiedMs != null
        ? { at: item.modifiedMs, kind: "changed" as const }
        : undefined;
  return classify({ path: item.path, size: item.size, dir: item.dir }, item.category, usage, now);
}

export function toRow(item: ScanItem, ai?: AiJudgement): Row {
  const cli = cliLabel(item);
  return { ...item, cli, ai, final: mergeVerdict({ blocked: item.blocked, category: item.category, cli, ai }) };
}

export function withAi(row: Row, ai: AiJudgement | undefined): Row {
  return { ...row, ai, final: mergeVerdict({ blocked: row.blocked, category: row.category, cli: row.cli, ai }) };
}

/** The verdict to show and act on. Signed-in users with plan usage get "pending" until the AI has judged a row (#12). */
export function forDisplay(row: Row, requireAi: boolean): Row {
  if (!requireAi || row.ai) return row;
  return { ...row, final: mergeVerdict({ blocked: row.blocked, category: row.category, cli: row.cli, requireAi }) };
}
