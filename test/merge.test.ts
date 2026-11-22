import { describe, expect, it } from "vitest";
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
