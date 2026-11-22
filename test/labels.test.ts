import { describe, expect, it } from "vitest";
import { BUCKET_JA, sourceJa, verdictClass, verdictJa, whyNotSelectable } from "../src/lib/labels";
import type { FinalVerdict } from "../src/safety/merge";

const f = (over: Partial<FinalVerdict>): FinalVerdict => ({ verdict: "safe", reason: "", locked: false, source: "ai", ...over });

describe("labels", () => {
  it("verdictJa and verdictClass show pending separately", () => {
    expect(verdictJa(f({ verdict: "safe" }))).toBe("削除していい");
    expect(verdictJa(f({ verdict: "keep" }))).toBe("消しちゃダメ");
    expect(verdictJa(f({ source: "pending", verdict: "caution" }))).toBe("未判定");
    expect(verdictClass(f({ verdict: "caution" }))).toBe("caution");
    expect(verdictClass(f({ source: "pending", verdict: "caution" }))).toBe("pending");
  });
  it("whyNotSelectable", () => {
    expect(whyNotSelectable(f({ locked: true, verdict: "keep", reason: "SSH の鍵" }))).toBe("SSH の鍵");
    expect(whyNotSelectable(f({ locked: true, verdict: "keep", reason: "" }))).toBe("保護されています");
    expect(whyNotSelectable(f({ source: "pending", verdict: "caution" }))).toBe("AI が判定していないため選べません");
    expect(whyNotSelectable(f({ verdict: "keep" }))).toBe("「消しちゃダメ」の判定");
    expect(whyNotSelectable(f({ verdict: "safe" }))).toBeNull();
    expect(whyNotSelectable(f({ verdict: "caution" }))).toBeNull();
  });
  it("sourceJa long and short", () => {
    expect(sourceJa(f({ source: "hard-block" }))).toBe("保護リスト");
    expect(sourceJa(f({ source: "cli" }))).toBe("元CLIのルール");
    expect(sourceJa(f({ source: "cli", locked: true }), true)).toBe("元CLI");
    expect(sourceJa(f({ source: "cli" }), true)).toBe("元CLIのみ");
    expect(sourceJa(f({ source: "pending" }))).toBe("AI 未判定");
    expect(sourceJa(f({ source: "ai" }))).toBe("AI＋ルール");
    expect(sourceJa(f({ source: "ai" }), true)).toBe("AI");
  });
  it("bucket names cover the verdicts plus locked and pending", () => {
    expect(BUCKET_JA).toEqual({ safe: "削除していい", caution: "注意", keep: "消しちゃダメ", locked: "保護", pending: "未判定" });
  });
});
