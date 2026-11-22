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
