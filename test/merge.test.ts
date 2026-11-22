import { describe, expect, it } from "vitest";
import { bucketOf, safePaths } from "../src/flow/progress";
import { mergeVerdict, selectable } from "../src/safety/merge";

const ai = (verdict: "safe" | "caution" | "keep") => ({ id: "i0", verdict, reason: "AI" });

describe("safety merge: hard block > fix-storage rules > AI", () => {
  it("hard block wins over AI safe", () => {
    const f = mergeVerdict({ blocked: "SSH の鍵", category: "developer", cli: { verdict: "unused", reason: "" }, ai: ai("safe") });
    expect(f).toMatchObject({ verdict: "keep", locked: true, source: "hard-block" });
    expect(selectable(f)).toBe(false);
  });
  it("fix-storage system verdict wins over AI safe", () => {
    const f = mergeVerdict({ blocked: null, category: "developer", cli: { verdict: "system", reason: "homebrew" }, ai: ai("safe") });
    expect(f.locked).toBe(true);
    expect(selectable(f)).toBe(false);
  });
  it("personal-data categories never become safe", () => {
    const f = mergeVerdict({ blocked: null, category: "photos", cli: { verdict: "unused", reason: "" }, ai: ai("safe") });
    expect(f.verdict).toBe("caution");
  });
  it("in-use data never becomes safe", () => {
    const f = mergeVerdict({ blocked: null, category: "documents", cli: { verdict: "yours", reason: "" }, ai: ai("safe") });
    expect(f.verdict).toBe("caution");
  });
  it("AI can make things stricter", () => {
    const f = mergeVerdict({ blocked: null, category: "caches", cli: { verdict: "junk", reason: "cache" }, ai: ai("keep") });
    expect(f.verdict).toBe("keep");
    expect(selectable(f)).toBe(false);
  });
  it("AI safe on junk stays safe", () => {
    const f = mergeVerdict({ blocked: null, category: "caches", cli: { verdict: "junk", reason: "cache" }, ai: ai("safe") });
    expect(f).toMatchObject({ verdict: "safe", source: "ai" });
    expect(selectable(f)).toBe(true);
  });
  it("without AI uses fix-storage verdicts", () => {
    expect(mergeVerdict({ blocked: null, category: "caches", cli: { verdict: "junk", reason: "" } }).verdict).toBe("safe");
    expect(mergeVerdict({ blocked: null, category: "documents", cli: { verdict: "unused", reason: "" } }).verdict).toBe("caution");
  });
});

describe("signed-in users: no deletion verdict until the AI has judged (#12)", () => {
  // ~/.cache/huggingface holds login tokens, yet the rules call every cache "junk".
  const cache = { blocked: null, category: "caches" as const, cli: { verdict: "junk" as const, reason: "cache" } };

  it("an item the AI has not judged is pending and cannot be selected", () => {
    const f = mergeVerdict({ ...cache, requireAi: true });
    expect(f.source).toBe("pending");
    expect(f.verdict).not.toBe("safe");
    expect(selectable(f)).toBe(false);
    expect(bucketOf(f)).toBe("pending");
    expect(safePaths([{ path: "/x", size: 1, final: f }])).toEqual([]);
  });
  it("pending items are not locked, so they are still sent to the AI", () => {
    expect(mergeVerdict({ ...cache, requireAi: true }).locked).toBe(false);
  });
  it("once judged, the AI verdict applies as before", () => {
    const f = mergeVerdict({ ...cache, requireAi: true, ai: ai("safe") });
    expect(f).toMatchObject({ verdict: "safe", source: "ai" });
    expect(selectable(f)).toBe(true);
  });
  it("hard block and the rules' system verdict still come first", () => {
    expect(mergeVerdict({ ...cache, blocked: "SSH の鍵", requireAi: true })).toMatchObject({ source: "hard-block", locked: true });
    expect(mergeVerdict({ ...cache, cli: { verdict: "system", reason: "homebrew" }, requireAi: true })).toMatchObject({ source: "cli", locked: true });
  });
  it("rule-only users keep the rules' verdict", () => {
    expect(mergeVerdict({ ...cache, requireAi: false })).toMatchObject({ verdict: "safe", source: "cli" });
  });
});

describe("folders holding a Git repository further down (#80)", () => {
  const junk = { blocked: null, category: "developer" as const, cli: { verdict: "junk" as const, reason: "cache" } };
  const repo = "/Users/a/.config/nvim";
  const warning = "中に Git リポジトリがあります（例: /Users/a/.config/nvim）";

  it("the rules' safe becomes caution, with the warning", () => {
    const f = mergeVerdict({ ...junk, gitInside: repo });
    expect(f).toMatchObject({ verdict: "caution", locked: false, source: "cli", warning });
    expect(selectable(f)).toBe(true);
    expect(safePaths([{ path: "/Users/a/.config", size: 1, final: f }])).toEqual([]);
  });
  it("the AI's safe becomes caution too, and the AI's reason stays", () => {
    const f = mergeVerdict({ ...junk, gitInside: repo, ai: ai("safe") });
    expect(f).toMatchObject({ verdict: "caution", source: "ai", reason: "AI", warning });
    expect(safePaths([{ path: "/Users/a/.config", size: 1, final: f }])).toEqual([]);
  });
  it("stricter verdicts are not loosened", () => {
    expect(mergeVerdict({ ...junk, gitInside: repo, ai: ai("keep") })).toMatchObject({ verdict: "keep", warning });
    expect(mergeVerdict({ ...junk, gitInside: repo, requireAi: true })).toMatchObject({ source: "pending", warning });
    expect(mergeVerdict({ ...junk, blocked: "SSH の鍵", gitInside: repo })).toMatchObject({ locked: true, source: "hard-block" });
    expect(mergeVerdict({ ...junk, cli: { verdict: "system", reason: "homebrew" }, gitInside: repo })).toMatchObject({ locked: true });
  });
  it("no repository, no warning", () => {
    expect(mergeVerdict({ ...junk, gitInside: null }).warning).toBeUndefined();
    expect(mergeVerdict(junk)).toMatchObject({ verdict: "safe" });
  });
});
