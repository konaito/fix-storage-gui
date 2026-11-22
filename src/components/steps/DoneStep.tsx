import type { TrashOutcome } from "../../lib/api";
import { formatBytes } from "../../lib/format";

interface Props {
  outcomes: TrashOutcome[];
  movedBytes: number;
  error: string | null;
  remaining: number;
  onBackToList: () => void;
  onRestart: () => void;
}

export function DoneStep({ outcomes, movedBytes, error, remaining, onBackToList, onRestart }: Props) {
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const allFailed = ok.length === 0;
  return (
    <section className="step-page">
      <div className={`done-hero ${allFailed ? "failed" : ""}`}>
        <div className="done-icon" aria-hidden="true">
          {allFailed ? "!" : "✓"}
        </div>
        <div className="eyebrow">ステップ 6</div>
        <h2>{allFailed ? "ゴミ箱へ移動できませんでした" : `${ok.length} 件をゴミ箱へ移動しました`}</h2>
        {!allFailed && (
          <p className="big-number">
            約 <strong>{formatBytes(movedBytes)}</strong>
          </p>
        )}
        {!allFailed && (
          <p className="muted">
            空き容量は、Finder でゴミ箱を空にしたときに増えます。間違えて移したものは、ゴミ箱から「戻す」で元の場所に戻せます。
          </p>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {failed.length > 0 && (
        <details className="card warn-box" open={failed.length <= 5}>
          <summary>{failed.length} 件は移動できませんでした</summary>
          <ul className="small">
            {failed.map((o) => (
              <li key={o.path}>
                <code>{o.path}</code>: {o.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="step-actions center">
        <button type="button" onClick={onBackToList}>
          一覧に戻る（残り {remaining} 件）
        </button>
        <button type="button" className="primary large" onClick={onRestart}>
          別の場所をスキャンする
        </button>
      </div>
    </section>
  );
}
