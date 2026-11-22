import { useState } from "react";
import { ratio } from "../../flow/progress";
import type { TrashProgress } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { AI_VERDICT_JA } from "../../lib/labels";
import type { Row } from "../../lib/rows";
import { CurrentPath, LoadingPanel, ProgressBar } from "../Loader";

interface Props {
  rows: Row[];
  trashing: boolean;
  progress: TrashProgress | null;
  onBack: () => void;
  onDeselect: (path: string) => void;
  onConfirm: () => void;
}

/** Final confirmation as its own step. Items go to the Trash (restorable with "戻す"); nothing is deleted for good. */
export function TrashStep({ rows, trashing, progress, onBack, onDeselect, onConfirm }: Props) {
  const [checked, setChecked] = useState(false);
  const total = rows.reduce((s, r) => s + r.size, 0);
  const caution = rows.filter((r) => r.final.verdict !== "safe");

  if (trashing) {
    return (
      <section className="step-page">
        <LoadingPanel title="ゴミ箱へ移動しています">
          <div className="row space small">
            <span>
              {progress ? Math.min(progress.done, progress.total) : 0} / {progress?.total ?? rows.length} 件
            </span>
          </div>
          <ProgressBar value={progress ? ratio(progress.done, progress.total) : null} label="移動済みの件数" />
          {progress && <CurrentPath path={progress.current} />}
          <p className="muted small">移動の直前に、1 件ずつ保護リストをもう一度確認しています。Finder の確認が出たら応答してください。</p>
        </LoadingPanel>
      </section>
    );
  }

  return (
    <section className="step-page">
      <header className="step-head">
        <div className="eyebrow">ステップ 5</div>
        <h2>ゴミ箱へ移動しますか？</h2>
        <p>
          <strong>{rows.length} 件・合計 約 {formatBytes(total)}</strong> をゴミ箱へ移動します。完全には削除しません。Finder のゴミ箱から「戻す」で元に戻せます。
        </p>
      </header>
      {caution.length > 0 && (
        <div className="callout warn-box">「{AI_VERDICT_JA.caution}」の項目が {caution.length} 件含まれています。内容をよく確認してください。</div>
      )}
      {rows.length === 0 ? (
        <div className="empty small-empty">
          <p className="muted">選択中の項目がありません。一覧に戻って選んでください。</p>
        </div>
      ) : (
        <ul className="confirm-list">
          {rows.map((r) => (
            <li key={r.path} className={r.final.verdict}>
              <span className={`badge ${r.final.verdict}`}>{AI_VERDICT_JA[r.final.verdict]}</span>
              <span className="confirm-path">{r.path}</span>
              <span className="muted num">{formatBytes(r.size)}</span>
              <button type="button" className="link" onClick={() => onDeselect(r.path)} aria-label={`${r.name} を外す`}>
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="confirm-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={rows.length === 0} />
        上のリストを確認しました
      </label>
      <div className="step-actions">
        <button type="button" onClick={onBack}>
          ← 戻る
        </button>
        <button type="button" className="danger large" disabled={!checked || rows.length === 0} onClick={onConfirm}>
          {rows.length} 件をゴミ箱へ移動
        </button>
      </div>
    </section>
  );
}
