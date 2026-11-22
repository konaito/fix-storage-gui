import { describe, expect, it } from "vitest";
import { backTarget, canGo, flowReducer, initialFlow, stepStatus, type FlowEvent, type FlowState } from "../src/flow/steps";
import { applyFilter, elapsedJa, phaseStates, ratio, safePaths, summarize } from "../src/flow/progress";
import { mergeVerdict } from "../src/safety/merge";

const run = (events: FlowEvent[], from: FlowState = initialFlow) => events.reduce(flowReducer, from);
const scanned = run([{ type: "scanStart" }, { type: "scanEnd", ok: true }]);

describe("step state machine", () => {
  it("starts at target and goes scanning → review on success", () => {
    expect(initialFlow.step).toBe("target");
    const s = run([{ type: "scanStart" }]);
    expect(s).toMatchObject({ step: "scanning", busy: "scan" });
    expect(scanned).toMatchObject({ step: "review", busy: null, hasScan: true });
  });

  it("a failed scan returns to target", () => {
    const s = run([{ type: "scanStart" }, { type: "scanEnd", ok: false }]);
    expect(s).toMatchObject({ step: "target", busy: null, hasScan: false });
  });

  it("a failed rescan keeps the previous list", () => {
    const s = run([{ type: "scanStart" }, { type: "scanEnd", ok: false }], scanned);
    expect(s).toMatchObject({ step: "review", busy: null, hasScan: true });
  });

  it("cannot jump anywhere while busy", () => {
    const s = run([{ type: "scanStart" }]);
    for (const to of ["target", "review", "ai", "trash", "done"] as const) expect(canGo(s, to, 3)).toBe(false);
    expect(run([{ type: "go", to: "target", selected: 0 }], s).step).toBe("scanning");
    expect(run([{ type: "reset" }], s).step).toBe("scanning");
    expect(backTarget(s)).toBeNull();
  });

  it("review/ai need a finished scan, trash needs a selection", () => {
    expect(canGo(initialFlow, "review", 0)).toBe(false);
    expect(canGo(initialFlow, "ai", 0)).toBe(false);
    expect(canGo(scanned, "ai", 0)).toBe(true);
    expect(canGo(scanned, "trash", 0)).toBe(false);
    expect(canGo(scanned, "trash", 2)).toBe(true);
    expect(canGo(scanned, "done", 2)).toBe(false);
    expect(canGo(scanned, "scanning", 2)).toBe(false);
  });

  it("AI run: start → end, step 4 shows done; skipping it shows skipped", () => {
    const ai = run([{ type: "aiStart" }], scanned);
    expect(ai).toMatchObject({ step: "ai", busy: "ai" });
    const done = run([{ type: "aiEnd", ok: true }], ai);
    expect(done).toMatchObject({ busy: null, aiDone: true });
    const skip = run([{ type: "go", to: "trash", selected: 1 }], scanned);
    expect(stepStatus(skip, "ai")).toBe("skipped");
    expect(stepStatus(run([{ type: "go", to: "trash", selected: 1 }], done), "ai")).toBe("done");
  });

  it("failed AI does not mark step 4 done", () => {
    const s = run([{ type: "aiStart" }, { type: "aiEnd", ok: false }], scanned);
    expect(s.aiDone).toBe(false);
  });

  it("back from trash returns to where it came from", () => {
    const viaAi = run([{ type: "go", to: "ai", selected: 1 }, { type: "go", to: "trash", selected: 1 }], scanned);
    expect(backTarget(viaAi)).toBe("ai");
    expect(run([{ type: "back", selected: 1 }], viaAi).step).toBe("ai");
    const viaReview = run([{ type: "go", to: "trash", selected: 1 }], scanned);
    expect(run([{ type: "back", selected: 1 }], viaReview).step).toBe("review");
  });

  it("trash only starts on the trash step and ends on done", () => {
    expect(run([{ type: "trashStart" }], scanned).busy).toBeNull();
    const t = run([{ type: "go", to: "trash", selected: 1 }, { type: "trashStart" }], scanned);
    expect(t.busy).toBe("trash");
    const d = run([{ type: "trashEnd" }], t);
    expect(d).toMatchObject({ step: "done", busy: null });
    expect(run([{ type: "back", selected: 0 }], d).step).toBe("review");
  });

  it("a new scan resets the AI state", () => {
    const ai = run([{ type: "aiStart" }, { type: "aiEnd", ok: true }], scanned);
    const again = run([{ type: "scanStart" }, { type: "scanEnd", ok: true }], ai);
    expect(again.aiDone).toBe(false);
  });

  it("step statuses", () => {
    expect(stepStatus(scanned, "target")).toBe("done");
    expect(stepStatus(scanned, "scanning")).toBe("done");
    expect(stepStatus(scanned, "review")).toBe("current");
    expect(stepStatus(scanned, "ai")).toBe("upcoming");
    expect(stepStatus(scanned, "done")).toBe("upcoming");
  });
});

describe("progress helpers", () => {
  it("ratio is null when the total is unknown — no fake percentages", () => {
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(5, 10)).toBe(0.5);
    expect(ratio(12, 10)).toBe(1);
  });
  it("phase checklist", () => {
    expect(phaseStates(null)).toEqual({ listing: "active", measuring: "pending", dates: "pending" });
    expect(phaseStates("measuring")).toEqual({ listing: "done", measuring: "active", dates: "pending" });
    expect(phaseStates("dates")).toEqual({ listing: "done", measuring: "done", dates: "active" });
  });
  it("elapsed", () => {
    expect(elapsedJa(5_400)).toBe("5秒");
    expect(elapsedJa(185_000)).toBe("3分05秒");
  });

  const row = (path: string, size: number, blocked: string | null, cli: "junk" | "unused" | "system") => ({
    path,
    size,
    final: mergeVerdict({ blocked, category: "caches", cli: { verdict: cli, reason: "" } }),
  });
  const rows = [row("/a", 10, null, "junk"), row("/b", 20, null, "unused"), row("/c", 40, "鍵", "junk"), row("/d", 80, null, "system")];

  it("summary buckets keep locked items separate", () => {
    const s = summarize(rows);
    expect(s.all).toEqual({ count: 4, size: 150 });
    expect(s.safe).toEqual({ count: 1, size: 10 });
    expect(s.caution).toEqual({ count: 1, size: 20 });
    expect(s.locked).toEqual({ count: 2, size: 120 });
  });
  it("filters and safe selection never include locked rows", () => {
    expect(applyFilter(rows, "locked").map((r) => r.path)).toEqual(["/c", "/d"]);
    expect(applyFilter(rows, "all")).toHaveLength(4);
    expect(safePaths(rows)).toEqual(["/a"]);
  });
});
