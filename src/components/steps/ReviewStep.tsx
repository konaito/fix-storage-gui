import { StepBar } from "../ActionBar";
import { useEffect, useMemo, useRef, useState } from "react";
import { sortRows, type SortMode } from "../../flow/order";
import { stepNo } from "../../flow/steps";
import { applyFilter, summarize, type Filter } from "../../flow/progress";
import { api } from "../../lib/api";
import { agoJa, formatBytes, isoDate } from "../../lib/format";
import { AI_VERDICT_JA, BUCKET_JA, CATEGORY_JA, CLI_VERDICT_JA, sourceJa, verdictClass, verdictJa, whyNotSelectable } from "../../lib/labels";
import type { Row } from "../../lib/rows";
import { selectable } from "../../safety/merge";
import { InfoPanel } from "../review/InfoPanel";
import { Treemap } from "../review/Treemap";
import { useFitHeight } from "../review/fit";
import type { Target } from "./TargetStep";

export type ReviewView = "map" | "list";

interface Props {
  rows: Row[];
  target: Target;
  denied: string[];
  partial: boolean;
  aiDone: boolean;
  /** The user uses AI judgement, so the list comes after the AI step (#12). */
  aiFirst: boolean;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSelectPaths: (paths: string[]) => void;
  onSelectAllSafe: () => void;
  onClearSelection: () => void;
  canGoUp: boolean;
  onGoUp: () => void;
  onDrill: (path: string) => void;
  onRescan: () => void;
  onChangeTarget: () => void;
  aiTargets: number;
  onGoAi: () => void;
  onGoTrash: () => void;
  home: string | null;
  view: ReviewView;
  onView: (v: ReviewView) => void;
  /** Effective order: size before AI, recommended (safe first) after, unless the user picked one. */
  sort: SortMode;
  onSort: (m: SortMode) => void;
}

export function ReviewStep(p: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const sum = useMemo(() => summarize(p.rows), [p.rows]);
  const shown = useMemo(() => sortRows(applyFilter(p.rows, filter), p.sort), [p.rows, filter, p.sort]);
  const [focus, setFocus] = useState<string | null>(null);
  // Keep the detail panel on something visible: default to the first tile (top-left).
  useEffect(() => {
    if (!focus || !shown.some((r) => r.path === focus)) setFocus(shown[0]?.path ?? null);
  }, [shown, focus]);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapHeight = useFitHeight(mapRef, [p.view, p.rows.length > 0, shown.length > 0]);
  const focused = shown.find((r) => r.path === focus) ?? null;
  const chosen = p.rows.filter((r) => p.selected.has(r.path) && selectable(r.final));
  const chosenSize = chosen.reduce((s, r) => s + r.size, 0);
  const shownSelectable = shown.filter((r) => selectable(r.final));
  const allShownChecked = shownSelectable.length > 0 && shownSelectable.every((r) => p.selected.has(r.path));

  return (
    <section className="step-page review">
      <StepBar
        eyebrow={`ステップ ${stepNo(p.aiFirst, "review")}`}
        title="ゴミ箱に移すものを選ぶ"
        desc={
          p.aiDone
            ? sum.pending.count > 0
              ? `AI の判定を反映しました。AI が判定していない ${sum.pending.count} 件は「未判定」で、選べません。`
              : "AI の判定を反映しました。「削除していい」から順に表示しています。"
            : p.aiFirst
              ? sum.pending.count > 0
                ? "AI 判定ができなかったため「未判定」のままで、選べません。「AI で判定する」からやり直してください。"
                : "AI に送る項目はありませんでした。項目をクリックすると右に詳細が出ます。"
              : "いまの判定は元 CLI のルールです。項目をクリックすると右に詳細が出ます。"
        }
        meta={
          <span className="sel-summary">
            選択中 <strong>{chosen.length}</strong> 件・約 <strong>{formatBytes(chosenSize)}</strong>
          </span>
        }
      >
        <button type="button" onClick={p.onGoAi} disabled={p.aiTargets === 0}>
          {p.aiDone ? "AI 判定の結果" : "AI で判定する"}（{p.aiTargets} 件）
        </button>
        <button type="button" className="primary large" disabled={chosen.length === 0} onClick={p.onGoTrash} title={chosen.length === 0 ? "項目を選ぶと進めます" : undefined}>
          ゴミ箱へ移動の確認へ →
        </button>
      </StepBar>

      <div className="context-row">
        {p.canGoUp && (
          <button type="button" className="link" onClick={p.onGoUp}>
            ← 上のフォルダへ
          </button>
        )}
        <span className="crumb" title={p.target.kind === "folder" ? p.target.path : undefined}>
          <span>{p.target.kind === "mac" ? "Mac 全体" : p.target.path}</span>
        </span>
        <span className="spacer" />
        <button type="button" className="link" onClick={p.onChangeTarget}>
          対象を変える
        </button>
        <button type="button" className="link" onClick={p.onRescan}>
          再スキャン
        </button>
      </div>

      {p.partial && <div className="notice">スキャンを途中で中止したため、途中までの結果です。</div>}

      {p.rows.length === 0 ? (
        <div className="empty">
          <div className="empty-icon" aria-hidden="true">🎉</div>
          <h3>条件に合う大きな項目は見つかりませんでした</h3>
          <p className="muted">最小サイズを小さくするか、別のフォルダを選んでもう一度スキャンしてみてください。</p>
          <button type="button" className="primary" onClick={p.onChangeTarget}>
            スキャン対象を変える
          </button>
        </div>
      ) : (
        <>
          {p.denied.length > 0 && (
            <details className="card warn-box denied-mini">
              <summary>
                読めなかったフォルダが {p.denied.length} 件あります（システム設定 → プライバシーとセキュリティ → フルディスクアクセス で許可すると計測できます）
              </summary>
              <ul className="small">
                {p.denied.slice(0, 50).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
          <div className={`stats tight ${sum.pending.count > 0 ? "six" : ""}`}>
            <button type="button" className={`stat ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
              <span className="stat-label">見つかった項目</span>
              <span className="stat-line">
                <span className="stat-value">{sum.all.count} 件</span>
                <span className="stat-sub">{formatBytes(sum.all.size)}</span>
              </span>
            </button>
            {(["safe", "caution", "keep", "locked", "pending"] as const).filter((b) => b !== "pending" || sum.pending.count > 0).map((b) => (
              <button type="button" key={b} className={`stat ${b} ${filter === b ? "on" : ""}`} onClick={() => setFilter(b)}>
                <span className="stat-label">{BUCKET_JA[b]}</span>
                <span className="stat-line">
                  <span className="stat-value">{sum[b].count} 件</span>
                  <span className="stat-sub">{formatBytes(sum[b].size)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="toolbar row space">
            <div className="row">
              <div className="segmented small" role="radiogroup" aria-label="表示">
                <button type="button" role="radio" aria-checked={p.view === "map"} className={p.view === "map" ? "on" : ""} onClick={() => p.onView("map")}>
                  ▦ マップ
                </button>
                <button type="button" role="radio" aria-checked={p.view === "list"} className={p.view === "list" ? "on" : ""} onClick={() => p.onView("list")}>
                  ☰ リスト
                </button>
              </div>
              <div className="segmented small" role="radiogroup" aria-label="並べ方">
                <button type="button" role="radio" aria-checked={p.sort === "recommended"} className={p.sort === "recommended" ? "on" : ""} onClick={() => p.onSort("recommended")} title="削除していい → 注意 → 消しちゃダメ・保護 の順。グループの中はサイズ順">
                  おすすめ順
                </button>
                <button type="button" role="radio" aria-checked={p.sort === "size"} className={p.sort === "size" ? "on" : ""} onClick={() => p.onSort("size")}>
                  サイズ順
                </button>
              </div>
              {filter !== "all" && (
                <button type="button" className="link small" onClick={() => setFilter("all")}>
                  絞り込みを解除
                </button>
              )}
            </div>
            <div className="row">
              <button type="button" onClick={p.onSelectAllSafe} disabled={sum.safe.count === 0}>
                「{AI_VERDICT_JA.safe}」をすべて選択
              </button>
              <button type="button" onClick={p.onClearSelection} disabled={chosen.length === 0}>
                選択を解除
              </button>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="empty small-empty">
              <p className="muted">この絞り込みに当てはまる項目はありません。</p>
            </div>
          ) : p.view === "map" ? (
            <div className="map-layout" ref={mapRef} style={mapHeight ? { height: mapHeight } : undefined}>
              <Treemap
                rows={shown}
                mode={p.sort}
                focus={focus}
                selected={p.selected}
                onFocus={setFocus}
                onToggle={p.onToggle}
                onDrill={p.onDrill}
              />
              <InfoPanel row={focused} home={p.home} selected={!!focused && p.selected.has(focused.path)} onToggle={p.onToggle} onDrill={p.onDrill} />
            </div>
          ) : (
            <div className="table-wrap" ref={mapRef} style={mapHeight ? { maxHeight: mapHeight } : undefined}>
              <table>
                <thead>
                  <tr>
                    <th className="check">
                      <input
                        type="checkbox"
                        aria-label="表示中の選べる項目をすべて選択"
                        checked={allShownChecked}
                        disabled={shownSelectable.length === 0}
                        onChange={() =>
                          allShownChecked
                            ? p.onSelectPaths([...p.selected].filter((x) => !shownSelectable.some((r) => r.path === x)))
                            : p.onSelectPaths([...new Set([...p.selected, ...shownSelectable.map((r) => r.path)])])
                        }
                      />
                    </th>
                    <th>名前</th>
                    <th className="num">サイズ</th>
                    <th>最終使用 / 更新</th>
                    <th>元 CLI の判定</th>
                    <th>判定（AI＋ルール）</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const can = selectable(r.final);
                    const on = p.selected.has(r.path) && can;
                    return (
                      <tr key={r.path} className={`${r.final.locked ? "locked" : ""} ${on ? "checked" : ""}`}>
                        <td className="check">
                          <input
                            type="checkbox"
                            aria-label={`${r.name} を選択`}
                            checked={on}
                            disabled={!can}
                            title={can ? undefined : whyNotSelectable(r.final) ?? undefined}
                            onChange={() => p.onToggle(r.path)}
                          />
                        </td>
                        <td className="name">
                          <div className="name-main">
                            <span aria-hidden="true">{r.final.locked ? "🔒" : r.dir ? "📁" : "📄"}</span> {r.name}
                          </div>
                          <div className="muted tiny path">
                            <span className="cat">{CATEGORY_JA[r.category]}</span>
                            {r.path}
                          </div>
                        </td>
                        <td className="num strong">{formatBytes(r.size)}</td>
                        <td className="dates">
                          <div title={isoDate(r.lastUsedMs) ?? "Spotlight に記録なし"}>{agoJa(r.lastUsedMs)}</div>
                          <div className="muted tiny" title={isoDate(r.modifiedMs) ?? ""}>
                            更新 {agoJa(r.modifiedMs)}
                          </div>
                        </td>
                        <td className="small">
                          <div>{CLI_VERDICT_JA[r.cli.verdict]}</div>
                          {r.cli.reason && <div className="muted tiny">{r.cli.reason}</div>}
                        </td>
                        <td className="small verdict">
                          <span className={`badge ${verdictClass(r.final)}`}>{verdictJa(r.final)}</span>
                          <span className="muted tiny">
                            {" "}
                            {sourceJa(r.final, true)}
                          </span>
                          {r.final.reason && <div className="tiny">{r.final.reason}</div>}
                          {r.final.warning && <div className="tiny warn">{r.final.warning}</div>}
                        </td>
                        <td className="actions">
                          <button type="button" className="link" onClick={() => void api.revealInFinder(r.path)}>
                            Finder
                          </button>
                          {r.dir && (
                            <button type="button" className="link" onClick={() => p.onDrill(r.path)}>
                              中を見る
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        </>
      )}

    </section>
  );
}
