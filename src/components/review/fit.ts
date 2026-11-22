import { useLayoutEffect, useState, type RefObject } from "react";

/** Minimum map height: below this the page scrolls instead of squeezing the tiles. */
export const MIN_MAP_HEIGHT = 200;

/**
 * Height that makes an element end right above what has to stay visible below it
 * (page padding). Never below `min`.
 */
export function fitHeight(viewport: number, top: number, reserve: number, min = MIN_MAP_HEIGHT): number {
  if (!Number.isFinite(viewport) || viewport <= 0) return min;
  return Math.max(min, Math.floor(viewport - top - reserve));
}

/**
 * Sizes the treemap + detail panel to the visible part of the app's scroll container (`.scroll`),
 * re-measuring on window / container / page resize (ResizeObserver).
 */
export function useFitHeight(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): number | null {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = (el.closest(".scroll") as HTMLElement | null) ?? document.documentElement;
    const page = el.closest(".step-page") as HTMLElement | null;
    const measure = () => {
      const sRect = scroller.getBoundingClientRect();
      const top = el.getBoundingClientRect().top - sRect.top + scroller.scrollTop;
      // The actions live in the top bar (outside `.scroll`), so only the page's own bottom padding stays below the map.
      const pagePad = page ? parseFloat(getComputedStyle(page).paddingBottom || "0") : 0;
      const layout = el.closest(".layout") as HTMLElement | null;
      const padBottom = layout ? parseFloat(getComputedStyle(layout).paddingBottom || "0") : 0;
      // + 2px for the page border.
      const next = fitHeight(scroller.clientHeight, top, pagePad + padBottom + 2);
      setH((cur) => (cur === next ? cur : next));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(scroller);
    if (page) ro?.observe(page);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return h;
}
