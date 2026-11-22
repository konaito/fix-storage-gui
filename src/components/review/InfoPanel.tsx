import { useEffect, useState } from "react";
import { api, type PreviewResult } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { agoJa, formatBytes, isoDate } from "../../lib/format";
import { kindLabel, locationParts } from "../../lib/kind";
import { AI_VERDICT_JA, CATEGORY_JA, CLI_VERDICT_JA } from "../../lib/labels";
import type { Row } from "../../lib/rows";
import { selectable } from "../../safety/merge";
import { useGate } from "../GateContext";
import { Spinner } from "../Loader";
import { ItemIcon } from "./icons";

interface Props {
  row: Row | null;
  home: string | null;
  selected: boolean;
  onToggle: (path: string) => void;
  onDrill: (path: string) => void;
}

type PreviewState = { path: string; loading: boolean; result: PreviewResult | null; error: string | null };

/**
 * Lazily loads a local preview for one path. A newer selection supersedes the old request on the Rust side
 * (generation counter), and leaving the panel cancels it. The preview stays in this component; it is never
 * part of the AI payload.
 */
function usePreview(path: string | null): [PreviewState | null, () => void, () => void] {
  const [state, setState] = useState<PreviewState | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) {
      setState(null);
      return;
    }
    let live = true;
    setState({ path, loading: true, result: null, error: null });
    const t = setTimeout(() => {
      api
        .previewItem(path)
        .then((result) => live && setState({ path, loading: false, result, error: null }))
        .catch((e) => live && setState({ path, loading: false, result: null, error: describeError(e) }));
    }, 160);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path, nonce]);
  useEffect(
    () => () => {
      void api.cancelPreview().catch(() => {});
    },
    [],
  );
  return [state, () => void api.cancelPreview().catch(() => {}), () => setNonce((n) => n + 1)];
}

function fmtDate(ms: number | null | undefined): string {
  const d = isoDate(ms);
  return d ? `${d}（${agoJa(ms)}）` : "—";
}

export function InfoPanel({ row, home, selected, onToggle, onDrill }: Props) {
  const [pv, cancel, retry] = usePreview(row?.path ?? null);
  const { ruleOnly } = useGate();
  if (!row) {
    return (
      <aside className="info-panel empty-panel">
        <p className="muted">マップの項目をクリックすると、ここに詳しい情報が出ます。</p>
      </aside>
    );
  }
  const can = selectable(row.final);
  const res = pv && pv.path === row.path ? pv.result : null;
  const loading = !!pv && pv.path === row.path && pv.loading;
  const thumb = res?.preview.kind === "image" ? res.preview.dataUrl : null;
  const lockedWhy = row.final.locked ? row.final.reason : row.final.verdict === "keep" ? "「消しちゃダメ」の判定" : null;

  return (
    <aside className="info-panel" aria-label="選択中の項目の情報">
      <header className="info-head">
        <div className="info-icon">{thumb ? <img src={thumb} alt="" /> : <ItemIcon name={row.name} dir={row.dir} size={48} muted={!can} />}</div>
        <div className="info-title">
          <div className="info-name">{row.name}</div>
          <div className="info-size">{formatBytes(row.size)}</div>
          <div className="muted tiny">変更日: {fmtDate(row.modifiedMs)}</div>
        </div>
      </header>

      <label className={`trash-toggle ${can ? "" : "disabled"} ${selected && can ? "on" : ""}`}>
        <input type="checkbox" checked={selected && can} disabled={!can} onChange={() => onToggle(row.path)} />
        <span>
          <strong>{can ? (selected ? "ゴミ箱の候補に入っています" : "ゴミ箱の候補に入れる") : "🔒 選べません"}</strong>
          {!can && lockedWhy && <span className="muted tiny block">{lockedWhy}</span>}
        </span>
      </label>

      <details open className="info-sec">
        <summary>判定</summary>
        <dl>
          <dt>結果</dt>
          <dd>
            <span className={`badge ${row.final.verdict}`}>{AI_VERDICT_JA[row.final.verdict]}</span>{" "}
            <span className="muted tiny">{row.final.source === "hard-block" ? "保護リスト" : row.final.source === "cli" ? "元CLIのルール" : "AI＋ルール"}</span>
            {row.final.reason && <div className="tiny">{row.final.reason}</div>}
          </dd>
          <dt>元 CLI</dt>
          <dd>
            {CATEGORY_JA[row.category]}・{CLI_VERDICT_JA[row.cli.verdict]}
            {row.cli.reason && <div className="muted tiny">{row.cli.reason}</div>}
          </dd>
          <dt>AI</dt>
          <dd>
            {row.ai ? (
              <>
                <span className={`badge ${row.ai.verdict}`}>{AI_VERDICT_JA[row.ai.verdict]}</span>
                <div className="tiny">{row.ai.reason}</div>
              </>
            ) : (
              <span className="muted">{row.final.locked ? "送っていません（保護対象）" : ruleOnly ? "ルールのみモード（AI 判定は使いません）" : "まだ判定していません"}</span>
            )}
          </dd>
        </dl>
      </details>

      <details open className="info-sec">
        <summary>一般情報</summary>
        <dl>
          <dt>種類</dt>
          <dd>{kindLabel(row.name, row.dir)}</dd>
          <dt>サイズ</dt>
          <dd>
            {formatBytes(row.size)}
            {res?.apparent != null && res.onDisk != null && (
              <div className="muted tiny">
                {res.apparent.toLocaleString()} バイト（ディスク上の {formatBytes(res.onDisk)}）
              </div>
            )}
            {row.dir && <div className="muted tiny">ディスク上の使用量（du で計測）</div>}
          </dd>
          <dt>場所</dt>
          <dd className="crumbs" title={row.path}>
            {locationParts(row.path, home).map((p, i) => (
              <span key={i}>
                {i > 0 && <span className="sep">›</span>}
                {p}
              </span>
            ))}
          </dd>
          <dt>作成日</dt>
          <dd>{loading && !res ? "…" : fmtDate(res?.createdMs)}</dd>
          <dt>変更日</dt>
          <dd>{fmtDate(row.modifiedMs)}</dd>
          <dt>最終使用日</dt>
          <dd>{row.lastUsedMs != null ? fmtDate(row.lastUsedMs) : <span className="muted">Spotlight に記録なし</span>}</dd>
        </dl>
      </details>

      <details open className="info-sec">
        <summary>プレビュー</summary>
        <div className="preview-area">
          {row.blocked && (!res || res.preview.kind === "blocked") ? (
            <p className="preview-note">🔒 プレビューしません（保護対象：{res?.preview.kind === "blocked" ? res.preview.reason : row.blocked}）</p>
          ) : loading ? (
            <div className="row">
              <Spinner size={16} label="プレビューを作成中" />
              <span className="muted small">プレビューを作成しています…</span>
              <button type="button" className="link" onClick={cancel}>
                中止
              </button>
            </div>
          ) : pv?.error ? (
            <p className="muted small">プレビューを作れませんでした：{pv.error}</p>
          ) : !res ? null : res.preview.kind === "blocked" ? (
            <p className="preview-note">🔒 プレビューしません（保護対象：{res.preview.reason}）</p>
          ) : res.preview.kind === "image" ? (
            <img className="preview-img" src={res.preview.dataUrl} alt={`${row.name} のプレビュー`} />
          ) : res.preview.kind === "text" ? (
            <pre className="preview-text">
              {res.preview.snippet}
              {res.preview.truncated && "\n…"}
            </pre>
          ) : res.preview.kind === "folder" ? (
            <div className="row">
              <ItemIcon name={row.name} dir size={32} />
              <span>
                {res.preview.count.toLocaleString()}
                {res.preview.more ? " 件以上" : " 項目"}
              </span>
            </div>
          ) : res.preview.kind === "cancelled" ? (
            <p className="muted small">
              中止しました。
              <button type="button" className="link" onClick={retry}>
                もう一度
              </button>
            </p>
          ) : res.preview.kind === "missing" ? (
            <p className="muted small">見つかりません（移動・削除された可能性）</p>
          ) : (
            <p className="muted small">プレビューはありません</p>
          )}
          <p className="muted tiny">プレビューはこの Mac の中だけで作ります。AI には送りません。</p>
        </div>
      </details>

      <div className="info-actions">
        <button type="button" onClick={() => void api.revealInFinder(row.path)}>
          Finder で表示
        </button>
        {row.dir && (
          <button type="button" onClick={() => onDrill(row.path)}>
            中を見る →
          </button>
        )}
      </div>
    </aside>
  );
}
