import { CATEGORY, type CategoryId } from "../cli-core/categories";
import type { Label } from "../cli-core/classify";
import type { AiJudgement, AiVerdict } from "../ai/provider";

export interface FinalVerdict {
  verdict: AiVerdict;
  reason: string;
  /** Locked items can never be selected for the Trash. */
  locked: boolean;
  /** "pending": the user uses AI judgement and the AI has not judged this item yet. */
  source: "hard-block" | "cli" | "ai" | "pending";
}

export interface MergeInput {
  blocked: string | null;
  category: CategoryId;
  cli: Label;
  ai?: AiJudgement;
  /** Signed-in users with ChatGPT plan usage: show no deletion verdict until the AI has judged the item (#12). */
  requireAi?: boolean;
}

const FROM_CLI: Record<Label["verdict"], AiVerdict> = {
  junk: "safe",
  unused: "caution",
  yours: "caution",
  system: "keep",
};

/** How the rules see a non-junk item, for the reason shown when the AI's "safe" is lowered. */
const NOT_JUNK: Record<Exclude<Label["verdict"], "junk" | "system">, string> = {
  unused: "使っていないかもしれないデータ扱い",
  yours: "使用中のデータ扱い",
};

export const PENDING_REASON = "AI がまだ判定していません";

/**
 * Safety order: hard block list > fix-storage's own rules > AI.
 * The AI can make things stricter, but never looser than the rules allow.
 * With `requireAi`, an item the AI has not judged gets no deletion verdict ("pending", not selectable).
 */
export function mergeVerdict({ blocked, category, cli, ai, requireAi }: MergeInput): FinalVerdict {
  if (blocked) return { verdict: "keep", reason: blocked, locked: true, source: "hard-block" };
  if (cli.verdict === "system") return { verdict: "keep", reason: cli.reason || "システムやツールが管理しています", locked: true, source: "cli" };
  if (!ai && requireAi) return { verdict: "caution", reason: PENDING_REASON, locked: false, source: "pending" };
  if (!ai) {
    return { verdict: FROM_CLI[cli.verdict], reason: cli.reason, locked: false, source: "cli" };
  }
  if (ai.verdict === "safe" && CATEGORY[category].tier === "keep") {
    return { verdict: "caution", reason: `${ai.reason}（元CLIでは個人データのカテゴリなので「注意」に下げました）`, locked: false, source: "ai" };
  }
  // Only the rules' "junk" may end up "safe"; for anything else the AI's "safe" stays "caution" (#19).
  if (ai.verdict === "safe" && cli.verdict !== "junk") {
    return { verdict: "caution", reason: `${ai.reason}（元CLIでは${NOT_JUNK[cli.verdict]}なので「注意」に下げました）`, locked: false, source: "ai" };
  }
  return { verdict: ai.verdict, reason: ai.reason, locked: false, source: "ai" };
}

export function selectable(f: FinalVerdict): boolean {
  return !f.locked && f.verdict !== "keep" && f.source !== "pending";
}
