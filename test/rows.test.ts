import { describe, expect, it } from "vitest";
import { aiSendTargets, cliLabel, forDisplay, toRow, withAi } from "../src/lib/rows";
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
    shared: false,
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

const cacheItem = (name: string): ScanItem => ({
  path: `/Users/u/Library/Caches/${name}`,
  name,
  size: 1024,
  dir: false,
  category: "caches",
  modifiedMs: null,
  lastUsedMs: null,
  blocked: null,
  shared: false,
});

describe("AI send targets (#75)", () => {
  const rows = ["a.zip", "b.zip", "c.zip"].map((n) => toRow(cacheItem(n)));

  it("sends everything when nothing has been judged yet", () => {
    expect(aiSendTargets(rows).map((r) => r.name)).toEqual(["a.zip", "b.zip", "c.zip"]);
  });

  it("continues with only the rows the AI has not judged (e.g. after signing in again)", () => {
    const partly = [withAi(rows[0], { id: "i0", verdict: "safe", reason: "old installer" }), rows[1], rows[2]];
    expect(aiSendTargets(partly).map((r) => r.name)).toEqual(["b.zip", "c.zip"]);
  });

  it("judges everything again once every row has a verdict", () => {
    const all = rows.map((r, i) => withAi(r, { id: `i${i}`, verdict: "safe", reason: "x" }));
    expect(aiSendTargets(all)).toHaveLength(3);
  });
});
