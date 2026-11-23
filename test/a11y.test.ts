import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stepper } from "../src/components/Stepper";
import { neighborTile, stepAriaLabel, tabStopTile, tileKeyAction, type NavDir, type NavRect } from "../src/flow/a11y";
import { layoutTreemap, type Sizable } from "../src/flow/order";
import { initialFlow, type FlowState } from "../src/flow/steps";
import type { FinalVerdict } from "../src/safety/merge";

const labels = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
const renderStepper = (flow: FlowState) => renderToStaticMarkup(createElement(Stepper, { flow, canGo: () => true, onGo: () => {} }));

describe("Stepper reads out each step's state (#43)", () => {
  it("done, current, optional and upcoming steps", () => {
    const html = renderStepper({ ...initialFlow, step: "review", hasScan: true });
    expect(labels(html)).toEqual([
      "スキャン対象を選ぶ、済み",
      "スキャン中、済み",
      "一覧を確認、いまのステップ",
      "AI 判定、これから、任意",
      "ゴミ箱へ移動の確認、これから",
      "完了、これから",
    ]);
    // The focused element is the button, so the current-step marker sits on it.
    expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*aria-label="一覧を確認、いまのステップ"/);
  });
  it("a passed-over AI step reads as skipped, a running step as busy", () => {
    const html = renderStepper({ ...initialFlow, step: "trash", hasScan: true, busy: "trash" });
    expect(labels(html)).toContain("AI 判定、スキップ");
    expect(labels(html)).toContain("ゴミ箱へ移動の確認、いまのステップ、処理中");
  });
  it("with aiFirst the AI step is not optional", () => {
    const html = renderStepper({ ...initialFlow, aiFirst: true, step: "ai", hasScan: true });
    expect(labels(html)).toContain("AI 判定、いまのステップ");
    expect(labels(html).some((l) => l.includes("任意"))).toBe(false);
  });
});

describe("stepAriaLabel", () => {
  it("never reads the last step as 完了、完了", () => {
    expect(stepAriaLabel("完了", "done", false, false)).toBe("完了、済み");
  });
  it("an optional step that was done stays marked optional; skipped does not repeat it", () => {
    expect(stepAriaLabel("AI 判定", "done", true, false)).toBe("AI 判定、済み、任意");
    expect(stepAriaLabel("AI 判定", "skipped", true, false)).toBe("AI 判定、スキップ");
  });
  it("busy only applies to the current step", () => {
    expect(stepAriaLabel("スキャン中", "done", false, true)).toBe("スキャン中、済み");
  });
});

describe("tileKeyAction", () => {
  it("maps each key to exactly one action", () => {
    expect(tileKeyAction(" ")).toEqual({ kind: "toggle" });
    expect(tileKeyAction("Enter")).toEqual({ kind: "detail" });
    expect(tileKeyAction("ArrowRight")).toEqual({ kind: "move", dir: "right" });
    expect(tileKeyAction("ArrowLeft")).toEqual({ kind: "move", dir: "left" });
    expect(tileKeyAction("ArrowUp")).toEqual({ kind: "move", dir: "up" });
    expect(tileKeyAction("ArrowDown")).toEqual({ kind: "move", dir: "down" });
    expect(tileKeyAction("Home")).toEqual({ kind: "first" });
    expect(tileKeyAction("End")).toEqual({ kind: "last" });
    expect(tileKeyAction("Tab")).toBeNull();
    expect(tileKeyAction("a")).toBeNull();
  });
});

describe("tabStopTile", () => {
  it("is the detail tile when drawn, else the first drawn tile", () => {
    expect(tabStopTile(["a", "b"], "b")).toBe("b");
    expect(tabStopTile(["a", "b"], "gone")).toBe("a");
    expect(tabStopTile(["a", "b"], null)).toBe("a");
    expect(tabStopTile([], "a")).toBeNull();
  });
});

describe("neighborTile", () => {
  // 2x2 grid with a wide tile under it:
  // a b
  // c d
  // e e
  const grid: NavRect[] = [
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 100, y: 0, w: 100, h: 100 },
    { id: "c", x: 0, y: 100, w: 100, h: 100 },
    { id: "d", x: 100, y: 100, w: 100, h: 100 },
    { id: "e", x: 0, y: 200, w: 200, h: 50 },
  ];
  it("moves to the adjacent tile in each direction", () => {
    expect(neighborTile(grid, "a", "right")).toBe("b");
    expect(neighborTile(grid, "a", "down")).toBe("c");
    expect(neighborTile(grid, "d", "left")).toBe("c");
    expect(neighborTile(grid, "d", "up")).toBe("b");
    expect(neighborTile(grid, "d", "down")).toBe("e");
    expect(neighborTile(grid, "e", "up")).toBe("c");
  });
  it("stays put at the edge", () => {
    expect(neighborTile(grid, "a", "left")).toBeNull();
    expect(neighborTile(grid, "a", "up")).toBeNull();
    expect(neighborTile(grid, "e", "down")).toBeNull();
  });

  const verdict = (i: number): FinalVerdict =>
    i % 7 === 3
      ? { verdict: "keep", reason: "", locked: true, source: "hard-block" }
      : { verdict: i % 2 ? "safe" : "caution", reason: "", locked: false, source: "cli" };
  const rowsOf = (n: number): Sizable[] => Array.from({ length: n }, (_, i) => ({ path: `/p${i}`, size: Math.round(1e9 / (i + 1) ** 1.1), final: verdict(i) }));

  it.each([
    ["size", 13, 900, 520],
    ["size", 40, 1100, 600],
    ["recommended", 13, 900, 520],
    ["recommended", 40, 1100, 600],
  ] as const)("every drawn tile is reachable with the arrow keys (%s, %i items, %ix%i)", (mode, n, w, h) => {
    const tiles = layoutTreemap(rowsOf(n), mode, w, h).tiles.filter((t) => t.w >= 6 && t.h >= 6);
    expect(tiles.length).toBeGreaterThan(5);
    const dirs: NavDir[] = ["left", "right", "up", "down"];
    const seen = new Set([tiles[0].id]);
    const queue = [tiles[0].id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const d of dirs) {
        const next = neighborTile(tiles, id, d);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual(tiles.map((t) => t.id).sort());
  });
});
