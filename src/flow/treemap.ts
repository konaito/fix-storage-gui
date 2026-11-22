/**
 * Squarified treemap (Bruls, Huizing & van Wijk, 2000), written for this app.
 * Items are laid out in the order given (callers sort), so the first item lands top-left.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapInput {
  id: string;
  value: number;
}

export interface TreemapTile extends Rect {
  id: string;
}

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(areas: number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Infinity;
  const sum = areas.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Infinity;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Lays out `items` (value > 0) in `rect`; areas are proportional to value. Order is kept. */
export function squarify(items: TreemapInput[], rect: Rect): TreemapTile[] {
  const list = items.filter((i) => Number.isFinite(i.value) && i.value > 0);
  const total = list.reduce((s, i) => s + i.value, 0);
  if (list.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = list.map((i) => i.value * scale);
  const out: TreemapTile[] = [];
  let free: Rect = { ...rect };
  let i = 0;
  while (i < list.length) {
    const side = Math.min(free.w, free.h);
    const row: number[] = [areas[i]];
    let j = i + 1;
    while (j < list.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    if (free.w >= free.h) {
      // Column on the left side.
      const colW = free.h > 0 ? rowSum / free.h : 0;
      let y = free.y;
      row.forEach((a, k) => {
        const h = colW > 0 ? a / colW : 0;
        out.push({ id: list[i + k].id, x: free.x, y, w: colW, h });
        y += h;
      });
      free = { x: free.x + colW, y: free.y, w: Math.max(0, free.w - colW), h: free.h };
    } else {
      // Row along the top.
      const rowH = free.w > 0 ? rowSum / free.w : 0;
      let x = free.x;
      row.forEach((a, k) => {
        const w = rowH > 0 ? a / rowH : 0;
        out.push({ id: list[i + k].id, x, y: free.y, w, h: rowH });
        x += w;
      });
      free = { x: free.x, y: free.y + rowH, w: free.w, h: Math.max(0, free.h - rowH) };
    }
    i = j;
  }
  return out;
}

/** "mang…nerator": keeps the start and the end of a name that does not fit in `max` characters. */
export function middleEllipsis(name: string, max: number): string {
  const chars = [...name];
  if (max <= 0) return "";
  if (chars.length <= max) return name;
  if (max <= 3) return chars.slice(0, max).join("");
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return chars.slice(0, head).join("") + "…" + (tail > 0 ? chars.slice(-tail).join("") : "");
}
