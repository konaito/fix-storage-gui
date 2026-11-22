import { useEffect, useMemo, useRef, useState } from "react";
import { neighborTile, tabStopTile, tileKeyAction } from "../../flow/a11y";
import { layoutTreemap, type SortMode } from "../../flow/order";
import type { Bucket } from "../../flow/progress";
import { middleEllipsis } from "../../flow/treemap";
import { formatBytes } from "../../lib/format";
import { AI_VERDICT_JA, BUCKET_JA } from "../../lib/labels";
import type { Row } from "../../lib/rows";
import { ItemIcon } from "./icons";

const GROUP_JA: Record<Bucket, string> = BUCKET_JA;
const GAP = 3;

interface Props {
  rows: Row[];
  mode: SortMode;
  focus: string | null;
  selected: Set<string>;
  onFocus: (path: string) => void;
  onToggle: (path: string) => void;
  onDrill: (path: string) => void;
}

/** Bento-style squarified treemap. Area ∝ size; colour = verdict; locked tiles are greyed out and cannot be selected. */
export function Treemap({ rows, mode, focus, selected, onFocus, onToggle, onDrill }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const layout = useMemo(() => layoutTreemap(rows, mode, box.w, box.h), [rows, mode, box.w, box.h]);
  const hidden = layout.tiles.filter((t) => t.w < 6 || t.h < 6).length;
  // Keyboard: the map is one Tab stop (roving tabindex) and the arrow keys move between the drawn tiles (#43).
  const drawn = useMemo(() => layout.tiles.filter((t) => byPath.has(t.id) && t.w >= 6 && t.h >= 6), [layout, byPath]);
  const tabStop = tabStopTile(drawn.map((t) => t.id), focus);
  const tileEls = useRef(new Map<string, HTMLDivElement>());
  const moveTo = (id: string | null | undefined) => {
    if (!id) return;
    tileEls.current.get(id)?.focus(); // the tile's focus handler shows its detail
  };

  return (
    <div className="treemap-shell">
      <div className="treemap" ref={ref} role="group" aria-label="サイズのマップ（面積がサイズ）">
        {layout.bandY != null && (
          <div className="band-label" style={{ top: layout.bandY }}>
            残すもの（下段にまとめて表示・選べません）
          </div>
        )}
        {mode === "recommended" &&
          layout.groups.map((g) => (
            <div key={g.bucket} className={`group-box ${g.bucket}`} style={{ left: g.x + 1, top: g.y + 1, width: Math.max(0, g.w - 2), height: Math.max(0, g.h - 2) }}>
              {g.h > 60 && g.w > 90 && (
                <div className="group-head">
                  <span className={`dot-mark ${g.bucket}`} />
                  {GROUP_JA[g.bucket]} <span className="group-meta">{g.count} 件・{formatBytes(g.size)}</span>
                </div>
              )}
            </div>
          ))}
        {layout.tiles.map((t) => {
          const r = byPath.get(t.id);
          if (!r || t.w < 6 || t.h < 6) return null;
          const w = t.w - GAP;
          const h = t.h - GAP;
          const on = selected.has(r.path) && t.selectable;
          const big = w >= 78 && h >= 62;
          const mid = !big && w >= 30 && h >= 30;
          const muted = !t.selectable;
          return (
            <div
              key={t.id}
              ref={(el) => {
                if (el) tileEls.current.set(t.id, el);
                else tileEls.current.delete(t.id);
              }}
              // Checked = in the trash candidates. Which tile's detail is shown is a separate state (aria-current).
              role="checkbox"
              aria-checked={on}
              aria-disabled={t.selectable ? undefined : true}
              aria-current={focus === r.path ? "true" : undefined}
              tabIndex={t.id === tabStop ? 0 : -1}
              aria-label={`${r.name}、${formatBytes(r.size)}、${BUCKET_JA[t.bucket]}${t.selectable ? "" : "、選べません"}`}
              title={`${r.path}\n${formatBytes(r.size)}・${BUCKET_JA[t.bucket]}${t.selectable ? "" : "（選べません）"}${r.dir ? "\nダブルクリックで中を見る" : ""}`}
              className={`tile ${t.bucket} ${focus === r.path ? "focus" : ""} ${on ? "on" : ""}`}
              style={{ left: t.x + GAP / 2, top: t.y + GAP / 2, width: w, height: h }}
              onFocus={() => onFocus(r.path)}
              onClick={(e) => {
                // A mouse click shows the detail. A click with detail 0 is not from a mouse; it is expected to come from
                // assistive technology pressing the checkbox, so it toggles like Space does (not checked with VoiceOver).
                if (e.detail === 0 && t.selectable) onToggle(r.path);
                else onFocus(r.path);
              }}
              onDoubleClick={() => r.dir && onDrill(r.path)}
              onKeyDown={(e) => {
                const a = tileKeyAction(e.key);
                if (!a || e.altKey || e.ctrlKey || e.metaKey) return;
                // A div gets no synthetic click from Enter / Space, so each key fires exactly one action here.
                e.preventDefault();
                if (a.kind === "toggle") {
                  if (t.selectable && !e.repeat) onToggle(r.path);
                } else if (a.kind === "detail") onFocus(r.path);
                else if (a.kind === "first") moveTo(drawn[0]?.id);
                else if (a.kind === "last") moveTo(drawn[drawn.length - 1]?.id);
                else moveTo(neighborTile(drawn, t.id, a.dir));
              }}
            >
              {(big || mid) && (
                <div className="tile-body">
                  <ItemIcon name={r.name} dir={r.dir} size={big ? Math.min(40, Math.max(24, Math.min(w, h) / 4)) : 18} muted={muted} />
                  {big && <div className="tile-name">{middleEllipsis(r.name, Math.max(4, Math.floor((w - 14) / 7.2)))}</div>}
                  {big && <div className="tile-size">{formatBytes(r.size)}</div>}
                </div>
              )}
              {t.selectable ? (
                (w >= 26 && h >= 26) || on ? (
                  // Mouse-only shortcut: the tile itself is the checkbox for the keyboard and screen readers.
                  <span
                    className="tile-check"
                    aria-hidden="true"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(r.path);
                    }}
                  >
                    {on ? "✓" : ""}
                  </span>
                ) : null
              ) : (
                w >= 22 && h >= 22 && (
                  <span className="tile-lock" aria-hidden="true">
                    🔒
                  </span>
                )
              )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="treemap-empty">表示する項目がありません</div>}
      </div>
      <div className="treemap-legend small">
        <span>
          <span className="dot-mark safe" />
          {AI_VERDICT_JA.safe}
        </span>
        <span>
          <span className="dot-mark caution" />
          {AI_VERDICT_JA.caution}
        </span>
        <span>
          <span className="dot-mark keep" />
          {AI_VERDICT_JA.keep}
        </span>
        <span>
          <span className="dot-mark locked" />
          保護
        </span>
        {rows.some((r) => r.final.source === "pending") && (
          <span>
            <span className="dot-mark pending" />
            {BUCKET_JA.pending}
          </span>
        )}
        <span className="muted">面積＝サイズ・クリックで詳細・右上の○でゴミ箱の候補に追加・フォルダはダブルクリックで中へ・矢印キーで移動、Space で候補に追加</span>
        {hidden > 0 && <span className="muted">（小さすぎて描けない {hidden} 件はリスト表示で確認できます）</span>}
      </div>
    </div>
  );
}
