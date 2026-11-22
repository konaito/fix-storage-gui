import type { FinalVerdict } from "../safety/merge";
import { selectable } from "../safety/merge";
import { bucketOf, type Bucket } from "./progress";
import { squarify, type Rect, type TreemapTile } from "./treemap";

/**
 * How the list / treemap is ordered.
 * - "size": biggest first (default before AI judgement).
 * - "recommended": what looks safe to delete first — 削除していい → 注意 → 消しちゃダメ → 保護,
 *   biggest first inside each group (default after AI judgement).
 */
export type SortMode = "recommended" | "size";

export const BUCKET_ORDER: Bucket[] = ["safe", "caution", "keep", "locked"];

export interface Sizable {
  path: string;
  size: number;
  final: FinalVerdict;
}

export function sortRows<T extends Sizable>(rows: T[], mode: SortMode): T[] {
  const bySize = (a: T, b: T) => b.size - a.size || a.path.localeCompare(b.path);
  if (mode === "size") return [...rows].sort(bySize);
  const rank = (r: T) => BUCKET_ORDER.indexOf(bucketOf(r.final));
  return [...rows].sort((a, b) => rank(a) - rank(b) || bySize(a, b));
}

/** Default mode: size until the AI has judged the list, then recommended. A user choice wins. */
export function effectiveSort(choice: SortMode | null, aiDone: boolean): SortMode {
  return choice ?? (aiDone ? "recommended" : "size");
}

export interface GroupBox extends Rect {
  bucket: Bucket;
  count: number;
  size: number;
}

export interface TreemapLayout {
  tiles: (TreemapTile & { bucket: Bucket; selectable: boolean })[];
  groups: GroupBox[];
  /** Top of the "残すもの" band in recommended mode (its areas are scaled separately), or null. */
  bandY: number | null;
}

/** Height of the "残すもの" band in recommended mode (fraction of the whole height). */
export const KEEP_BAND = 0.24;
const HEADER = 20;

function layoutGroups<T extends Sizable>(rows: T[], buckets: Bucket[], rect: Rect, out: TreemapLayout) {
  const groups = buckets
    .map((b) => {
      const items = sortRows(
        rows.filter((r) => bucketOf(r.final) === b),
        "size",
      );
      return { b, items, size: items.reduce((s, r) => s + r.size, 0) };
    })
    .filter((g) => g.items.length > 0 && g.size > 0);
  const boxes = squarify(
    groups.map((g) => ({ id: g.b, value: g.size })),
    rect,
  );
  for (const box of boxes) {
    const g = groups.find((x) => x.b === box.id)!;
    out.groups.push({ ...box, bucket: g.b, count: g.items.length, size: g.size });
    const header = box.h > HEADER * 3 && box.w > 90 ? HEADER : 0;
    const inner = { x: box.x, y: box.y + header, w: box.w, h: box.h - header };
    for (const t of squarify(
      g.items.map((r) => ({ id: r.path, value: r.size })),
      inner,
    )) {
      const r = g.items.find((x) => x.path === t.id)!;
      out.tiles.push({ ...t, bucket: g.b, selectable: selectable(r.final) });
    }
  }
}

/**
 * Treemap for the review step.
 * size: one treemap of everything, area ∝ size (colour shows the verdict).
 * recommended: 削除していい / 注意 get the main canvas (safe group top-left), and 消しちゃダメ / 保護
 * are pushed into a short band at the bottom. Inside every group area stays proportional to size.
 */
export function layoutTreemap<T extends Sizable>(rows: T[], mode: SortMode, w: number, h: number): TreemapLayout {
  const out: TreemapLayout = { tiles: [], groups: [], bandY: null };
  if (w <= 0 || h <= 0) return out;
  if (mode === "size") {
    for (const t of squarify(
      sortRows(rows, "size").map((r) => ({ id: r.path, value: r.size })),
      { x: 0, y: 0, w, h },
    )) {
      const r = rows.find((x) => x.path === t.id)!;
      out.tiles.push({ ...t, bucket: bucketOf(r.final), selectable: selectable(r.final) });
    }
    return out;
  }
  const active = rows.filter((r) => ["safe", "caution"].includes(bucketOf(r.final)) && r.size > 0);
  const rest = rows.filter((r) => ["keep", "locked"].includes(bucketOf(r.final)) && r.size > 0);
  if (active.length === 0 || rest.length === 0) {
    layoutGroups(rows, BUCKET_ORDER, { x: 0, y: 0, w, h }, out);
    return out;
  }
  const bandH = Math.round(h * KEEP_BAND);
  layoutGroups(active, ["safe", "caution"], { x: 0, y: 0, w, h: h - bandH }, out);
  out.bandY = h - bandH;
  layoutGroups(rest, ["keep", "locked"], { x: 0, y: h - bandH, w, h: bandH }, out);
  return out;
}
