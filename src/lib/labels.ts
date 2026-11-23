import type { CategoryId, Tier } from "../cli-core/categories";
import type { Verdict } from "../cli-core/classify";
import type { AiVerdict } from "../ai/provider";
import type { Bucket } from "../flow/progress";
import type { FinalVerdict } from "../safety/merge";

export const CATEGORY_JA: Record<CategoryId, string> = {
  apps: "アプリ",
  developer: "開発",
  photos: "写真",
  movies: "ムービー",
  documents: "書類",
  music: "ミュージック",
  system: "システム",
  caches: "キャッシュ",
  trash: "ゴミ箱",
};

export const TIER_JA: Record<Tier, string> = {
  safe: "消してOK",
  review: "要確認",
  keep: "残す",
};

/** fix-storage's verdicts in Japanese. */
export const CLI_VERDICT_JA: Record<Verdict, string> = {
  junk: "不要（再生成できる）",
  unused: "使っていないかも",
  yours: "あなたのデータ",
  system: "システム/ツール管理",
};

export const AI_VERDICT_JA: Record<AiVerdict, string> = {
  safe: "削除していい",
  caution: "注意",
  keep: "消しちゃダメ",
};

/** Badge text and class for a final verdict ("未判定" while the AI has not judged it). */
export function verdictJa(f: FinalVerdict): string {
  return f.source === "pending" ? "未判定" : AI_VERDICT_JA[f.verdict];
}
export function verdictClass(f: FinalVerdict): string {
  return f.source === "pending" ? "pending" : f.verdict;
}

/** Why an item cannot be put in the Trash, or null when it can. */
export function whyNotSelectable(f: FinalVerdict): string | null {
  if (f.locked) return f.reason || "保護されています";
  if (f.source === "pending") return "AI が判定していないため選べません";
  if (f.verdict === "keep") return "「消しちゃダメ」の判定";
  return null;
}

/** Where the final verdict came from, for the list and the detail panel. */
export function sourceJa(f: FinalVerdict, short = false): string {
  switch (f.source) {
    case "hard-block":
      return "保護リスト";
    case "cli":
      return short ? (f.locked ? "元CLI" : "元CLIのみ") : "元CLIのルール";
    case "pending":
      return "AI 未判定";
    case "ai":
      return short ? "AI" : "AI＋ルール";
  }
}

/** Group names in the list, the treemap and the summary cards. */
export const BUCKET_JA: Record<Bucket, string> = { ...AI_VERDICT_JA, locked: "保護", pending: "未判定" };

/** Shown wherever a size counts an item that holds hard links (#34): du counts the shared blocks in full for every item. */
export const SHARED_JA = "共有あり";
export const SHARED_NOTE_JA = "共有あり。空く量は少ないことがある";
