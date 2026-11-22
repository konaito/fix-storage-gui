/**
 * Screen reader labels and keyboard handling for the stepper and the treemap (#43).
 * Pure functions so they can be unit-tested in test/a11y.test.ts.
 */
import type { StepStatus } from "./steps";

const STATUS_JA: Record<StepStatus, string> = {
  done: "済み",
  current: "いまのステップ",
  upcoming: "これから",
  skipped: "スキップ",
};

/**
 * Accessible name of one stepper button: the step label plus its state, e.g. "AI 判定、スキップ".
 * `optional` must match when the stepper shows the "任意 / スキップ" tag (the AI step without aiFirst).
 * "済み" instead of "完了" so the last step does not read as "完了、完了".
 */
export function stepAriaLabel(label: string, status: StepStatus, optional: boolean, busy: boolean): string {
  const parts = [label, STATUS_JA[status]];
  if (optional && status !== "skipped") parts.push("任意");
  if (busy && status === "current") parts.push("処理中");
  return parts.join("、");
}

export type NavDir = "left" | "right" | "up" | "down";

export type TileKeyAction = { kind: "move"; dir: NavDir } | { kind: "first" } | { kind: "last" } | { kind: "toggle" } | { kind: "detail" } | null;

/**
 * What a key does on a treemap tile (roving tabindex: the map is one Tab stop).
 * Arrows move to the neighbouring tile (its detail follows), Home / End jump to the first / last tile,
 * Space adds or removes the trash candidate, Enter shows the detail. Anything else is left to the browser.
 */
export function tileKeyAction(key: string): TileKeyAction {
  switch (key) {
    case "ArrowLeft":
      return { kind: "move", dir: "left" };
    case "ArrowRight":
      return { kind: "move", dir: "right" };
    case "ArrowUp":
      return { kind: "move", dir: "up" };
    case "ArrowDown":
      return { kind: "move", dir: "down" };
    case "Home":
      return { kind: "first" };
    case "End":
      return { kind: "last" };
    case " ":
      return { kind: "toggle" };
    case "Enter":
      return { kind: "detail" };
    default:
      return null;
  }
}

export interface NavRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 0.5;

/** Distance between two ranges [a, a+al] and [b, b+bl]; 0 when they overlap. */
function gap(a: number, al: number, b: number, bl: number): number {
  return Math.max(0, b - (a + al), a - (b + bl));
}

/**
 * The tile an arrow key moves to: among the tiles lying entirely on that side of `fromId`, the one with the
 * smallest edge distance, preferring tiles that line up with it. null when there is none (stay put).
 */
export function neighborTile(tiles: NavRect[], fromId: string, dir: NavDir): string | null {
  const f = tiles.find((t) => t.id === fromId);
  if (!f) return tiles[0]?.id ?? null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const t of tiles) {
    if (t.id === f.id) continue;
    let along: number;
    let perp: number;
    let offset: number;
    if (dir === "left" || dir === "right") {
      along = dir === "right" ? t.x - (f.x + f.w) : f.x - (t.x + t.w);
      perp = gap(t.y, t.h, f.y, f.h);
      offset = Math.abs(t.y + t.h / 2 - (f.y + f.h / 2));
    } else {
      along = dir === "down" ? t.y - (f.y + f.h) : f.y - (t.y + t.h);
      perp = gap(t.x, t.w, f.x, f.w);
      offset = Math.abs(t.x + t.w / 2 - (f.x + f.w / 2));
    }
    if (along < -EPS) continue;
    const score = Math.max(0, along) + perp * 3 + offset * 0.001;
    if (score < bestScore) {
      bestScore = score;
      best = t.id;
    }
  }
  return best;
}

/** The single tile that is in the Tab order: the one whose detail is shown, else the first drawn tile. */
export function tabStopTile(ids: string[], focus: string | null): string | null {
  if (focus && ids.includes(focus)) return focus;
  return ids[0] ?? null;
}
