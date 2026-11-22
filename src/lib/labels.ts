import type { CategoryId, Tier } from "../cli-core/categories";
import type { Verdict } from "../cli-core/classify";
import type { AiVerdict } from "../ai/provider";

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
