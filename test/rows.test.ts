import { describe, expect, it } from "vitest";
import { cliLabel, forDisplay, toRow, withAi } from "../src/lib/rows";
import type { ScanItem } from "../src/lib/api";

const DAY = 24 * 3600 * 1000;
const now = Date.parse("2026-11-22T00:00:00Z");

function item(over: Partial<ScanItem> = {}): ScanItem {
  return {
    path: "/Users/a/Downloads/Foo.dmg",
    name: "Foo.dmg",
    size: 100,
    dir: false,
    category: "documents",
    modifiedMs: null,
    lastUsedMs: null,
    blocked: null,
    ...over,
  };
}

describe("cliLabel", () => {
  it("prefers the last-opened date over the modified date", () => {
    const old = now - 400 * DAY;
    const opened = cliLabel(item({ path: "/Users/a/Documents/x.psd", name: "x.psd", lastUsedMs: old, modifiedMs: now }), now);
    expect(opened.verdict).toBe("unused");
    expect(opened.reason).toContain("not opened");
  });
  it("falls back to the modified date", () => {
    const changed = cliLabel(item({ path: "/Users/a/Documents/x.psd", name: "x.psd", modifiedMs: now - 400 * DAY }), now);
    expect(changed.verdict).toBe("unused");
    expect(changed.reason).toContain("not touched");
  });
  it("without dates the item is yours", () => {
    expect(cliLabel(item({ path: "/Users/a/Documents/x.psd", name: "x.psd" }), now).verdict).toBe("yours");
  });
});

describe("toRow / withAi / forDisplay", () => {
  it("a hard-blocked item is locked whatever the rules or the AI say", () => {
    const row = toRow(item({ blocked: "SSH の鍵" }), { id: "1", verdict: "safe", reason: "ok" });
    expect(row.final).toMatchObject({ verdict: "keep", locked: true, source: "hard-block", reason: "SSH の鍵" });
  });
  it("an installer is safe from the rules alone", () => {
    const row = toRow(item());
    expect(row.cli.verdict).toBe("junk");
    expect(row.final).toMatchObject({ verdict: "safe", locked: false, source: "cli" });
  });
  it("withAi recomputes the final verdict and keeps the rule label", () => {
    const row = toRow(item());
    const judged = withAi(row, { id: "1", verdict: "keep", reason: "needed" });
    expect(judged.cli).toBe(row.cli);
    expect(judged.final).toMatchObject({ verdict: "keep", source: "ai" });
    expect(withAi(judged, undefined).final.source).toBe("cli");
  });
  it("forDisplay holds rows back until the AI has judged them, only when required", () => {
    const row = toRow(item());
    expect(forDisplay(row, false)).toBe(row);
    expect(forDisplay(row, true).final.source).toBe("pending");
    const judged = withAi(row, { id: "1", verdict: "safe", reason: "ok" });
    expect(forDisplay(judged, true)).toBe(judged);
  });
});
