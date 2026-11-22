import { describe, expect, it } from "vitest";
import { squarify, middleEllipsis, type TreemapTile } from "../src/flow/treemap";
import { effectiveSort, KEEP_BAND, layoutTreemap, sortRows } from "../src/flow/order";
import { mergeVerdict } from "../src/safety/merge";

const area = (t: TreemapTile) => t.w * t.h;
const overlap = (a: TreemapTile, b: TreemapTile) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe("squarify", () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: `i${i}`, value: v }));
  const rect = { x: 0, y: 0, w: 600, h: 400 };
  const tiles = squarify(items, rect);

  it("areas are proportional to value and fill the rect", () => {
    expect(tiles).toHaveLength(7);
    const total = tiles.reduce((s, t) => s + area(t), 0);
    expect(total).toBeCloseTo(600 * 400, 3);
    tiles.forEach((t, i) => expect(area(t)).toBeCloseTo((items[i].value / 24) * 240000, 3));
  });
  it("tiles stay inside the rect and do not overlap", () => {
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(400 + 1e-6);
    }
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlap(tiles[i], tiles[j])).toBeLessThan(1e-6);
  });
  it("the first item lands top-left", () => {
    expect(tiles[0]).toMatchObject({ x: 0, y: 0 });
  });
  it("aspect ratios are reasonable (squarified, not slices)", () => {
    for (const t of tiles.slice(0, 5)) expect(Math.max(t.w / t.h, t.h / t.w)).toBeLessThan(4);
  });
  it("ignores zero / negative values and empty rects", () => {
    expect(squarify([{ id: "a", value: 0 }, { id: "b", value: -1 }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
    expect(squarify([{ id: "a", value: 5 }], rect)).toEqual([{ id: "a", x: 0, y: 0, w: 600, h: 400 }]);
  });
});

describe("middleEllipsis", () => {
  it("keeps head and tail", () => {
    expect(middleEllipsis("manga-generator", 12)).toBe("manga-…rator");
    expect(middleEllipsis("short", 12)).toBe("short");
    expect(middleEllipsis("写真ライブラリ.photoslibrary", 8)).toBe("写真ライ…ary");
    expect([...middleEllipsis("abcdefghijklmnop", 7)]).toHaveLength(7);
    expect(middleEllipsis("abc", 0)).toBe("");
  });
});

const row = (path: string, size: number, opts: { blocked?: string; cli?: "junk" | "unused" | "system" | "yours"; ai?: "safe" | "caution" | "keep" } = {}) => ({
  path,
  size,
  final: mergeVerdict({
    blocked: opts.blocked ?? null,
    category: "caches",
    cli: { verdict: opts.cli ?? "junk", reason: "" },
    ai: opts.ai ? { id: path, verdict: opts.ai, reason: "AI" } : undefined,
  }),
});

const rows = [
  row("/photos", 900, { cli: "unused", ai: "keep" }), // keep
  row("/keychain", 500, { blocked: "鍵" }), // locked
  row("/cache-small", 10, { ai: "safe" }), // safe
  row("/cache-big", 100, { ai: "safe" }), // safe
  row("/movie", 300, { cli: "unused", ai: "caution" }), // caution
];

describe("ordering", () => {
  it("size: biggest first", () => {
    expect(sortRows(rows, "size").map((r) => r.path)).toEqual(["/photos", "/keychain", "/movie", "/cache-big", "/cache-small"]);
  });
  it("recommended: safe → caution → keep → locked, biggest first inside a group", () => {
    expect(sortRows(rows, "recommended").map((r) => r.path)).toEqual(["/cache-big", "/cache-small", "/movie", "/photos", "/keychain"]);
  });
  it("default is size before AI, recommended after; a user choice wins", () => {
    expect(effectiveSort(null, false)).toBe("size");
    expect(effectiveSort(null, true)).toBe("recommended");
    expect(effectiveSort("size", true)).toBe("size");
    expect(effectiveSort("recommended", false)).toBe("recommended");
  });
});

describe("layoutTreemap", () => {
  it("size mode: one treemap, biggest top-left, locked tiles unselectable", () => {
    const l = layoutTreemap(rows, "size", 800, 500);
    expect(l.tiles).toHaveLength(5);
    expect(l.tiles[0]).toMatchObject({ id: "/photos", x: 0, y: 0 });
    expect(l.tiles.find((t) => t.id === "/keychain")).toMatchObject({ bucket: "locked", selectable: false });
    expect(l.tiles.find((t) => t.id === "/photos")!.selectable).toBe(false);
    expect(l.bandY).toBeNull();
  });
  it("recommended mode: safe group top-left, keep/locked pushed into the bottom band", () => {
    const l = layoutTreemap(rows, "recommended", 800, 500);
    const safe = l.groups.find((g) => g.bucket === "safe")!;
    expect(safe).toMatchObject({ x: 0, y: 0, count: 2, size: 110 });
    expect(l.bandY).toBe(500 - Math.round(500 * KEEP_BAND));
    for (const t of l.tiles.filter((t) => t.bucket === "keep" || t.bucket === "locked")) expect(t.y).toBeGreaterThanOrEqual(l.bandY! - 1e-6);
    for (const t of l.tiles.filter((t) => t.bucket === "safe" || t.bucket === "caution")) expect(t.y + t.h).toBeLessThanOrEqual(l.bandY! + 1e-6);
    // Inside a group, area still follows size.
    const big = l.tiles.find((t) => t.id === "/cache-big")!;
    const small = l.tiles.find((t) => t.id === "/cache-small")!;
    expect(area(big) / area(small)).toBeCloseTo(10, 1);
  });
  it("recommended mode without anything to keep uses the whole canvas", () => {
    const l = layoutTreemap(rows.slice(2), "recommended", 800, 500);
    expect(l.bandY).toBeNull();
    expect(l.groups.map((g) => g.bucket)).toEqual(["safe", "caution"]);
  });
  it("empty and zero-size", () => {
    expect(layoutTreemap([], "size", 800, 500).tiles).toEqual([]);
    expect(layoutTreemap(rows, "size", 0, 500).tiles).toEqual([]);
  });
});

import { kindLabel, locationParts } from "../src/lib/kind";

describe("kind and location (display only)", () => {
  it("kind labels", () => {
    expect(kindLabel("Xcode.dmg", false)).toBe("ディスクイメージ");
    expect(kindLabel("Old.app", true)).toBe("アプリケーション");
    expect(kindLabel("node_modules", true)).toBe("フォルダ");
    expect(kindLabel("data.weird", false)).toBe("WEIRD ファイル");
    expect(kindLabel("Makefile", false)).toBe("書類");
  });
  it("location breadcrumb", () => {
    expect(locationParts("/Users/k/Library/Caches/x", "/Users/k")).toEqual(["ホーム", "Library", "Caches"]);
    expect(locationParts("/Users/k/x", "/Users/k/")).toEqual(["ホーム"]);
    expect(locationParts("/Applications/Old.app", "/Users/k")).toEqual(["Macintosh HD", "Applications"]);
  });
});

import { agoJa } from "../src/lib/format";
describe("agoJa", () => {
  it("never says 0か月前", () => {
    const now = Date.UTC(2026, 10, 22);
    expect(agoJa(now - 30 * 86400000, now)).toBe("1か月前");
  });
});
