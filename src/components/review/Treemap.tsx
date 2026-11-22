import { useEffect, useMemo, useRef, useState } from "react";
import { layoutTreemap, type SortMode } from "../../flow/order";
import type { Bucket } from "../../flow/progress";
import { middleEllipsis } from "../../flow/treemap";
import { formatBytes } from "../../lib/format";
import { AI_VERDICT_JA } from "../../lib/labels";
import type { Row } from "../../lib/rows";
import { ItemIcon } from "./icons";

const GROUP_JA: Record<Bucket, string> = { safe: AI_VERDICT_JA.safe, caution: AI_VERDICT_JA.caution, keep: AI_VERDICT_JA.keep, locked: "保護" };
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
              role="button"
              tabIndex={0}
              aria-pressed={focus === r.path}
              aria-label={`${r.name}、${formatBytes(r.size)}、${t.bucket === "locked" ? "保護" : AI_VERDICT_JA[r.final.verdict]}${on ? "、ゴミ箱の候補" : ""}`}
              title={`${r.path}\n${formatBytes(r.size)}・${t.bucket === "locked" ? "保護（選べません）" : AI_VERDICT_JA[r.final.verdict]}${r.dir ? "\nダブルクリックで中を見る" : ""}`}
              className={`tile ${t.bucket} ${focus === r.path ? "focus" : ""} ${on ? "on" : ""}`}
              style={{ left: t.x + GAP / 2, top: t.y + GAP / 2, width: w, height: h }}
              onClick={() => onFocus(r.path)}
              onDoubleClick={() => r.dir && onDrill(r.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onFocus(r.path);
                if (e.key === " " && t.selectable) {
                  e.preventDefault();
                  onToggle(r.path);
                }
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
                  <button
                    type="button"
                    className="tile-check"
                    aria-label={on ? `${r.name} を候補から外す` : `${r.name} をゴミ箱の候補に入れる`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(r.path);
                    }}
                  >
                    {on ? "✓" : ""}
                  </button>
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
        <span className="muted">面積＝サイズ・クリックで詳細・右上の○でゴミ箱の候補に追加・フォルダはダブルクリックで中へ</span>
        {hidden > 0 && <span className="muted">（小さすぎて描けない {hidden} 件はリスト表示で確認できます）</span>}
      </div>
    </div>
  );
}
