import { useEffect, useState } from "react";
import { elapsedJa, ratio, type Bucket, type VerdictSummary } from "../../flow/progress";
import { formatBytes } from "../../lib/format";
import { AI_VERDICT_JA } from "../../lib/labels";
import { LoadingPanel, ProgressBar } from "../Loader";

export interface AiRun {
  done: number;
  total: number;
  batch: number;
  batches: number;
  chars: number;
  startedAt: number;
  stopRequested: boolean;
}

export interface AiOutcome {
  judged: number;
  missing: number;
  stopped: boolean;
  error: string | null;
}

interface Props {
  planReady: boolean;
  signedIn: boolean;
  modelName: string | null;
  modelsLoading: boolean;
  destination: string;
  targets: number;
  batchSize: number;
  running: AiRun | null;
  outcome: AiOutcome | null;
  summary: Record<Bucket | "all", VerdictSummary>;
  selectedCount: number;
  onOpenSend: () => void;
  onStop: () => void;
  onGoReview: () => void;
  onGoTrash: () => void;
}

export function AiStep(p: Props) {
  if (p.running) return <AiRunning run={p.running} destination={p.destination} onStop={p.onStop} />;
  const batches = Math.ceil(p.targets / p.batchSize);

  return (
    <section className="step-page">
      <header className="step-head">
        <div className="eyebrow">ステップ 4（任意）</div>
        <h2>AI に判定してもらう</h2>
        <p className="muted">
          ファイル名・パス・サイズ・日付・元 CLI の判定といった<strong>メタデータだけ</strong>を {p.destination} に送り、ゴミ箱に移してよいかの意見をもらいます。
          <strong>ファイルの中身は送りません。</strong>送る前に、実際に送る内容をすべて確認できます。
        </p>
      </header>

      {p.outcome && (
        <div className={`result-card ${p.outcome.error ? "error-card" : ""}`}>
          {p.outcome.error ? (
            <>
              <h3>AI 判定を完了できませんでした</h3>
              <p>{p.outcome.error}</p>
              {p.outcome.judged > 0 && <p className="muted small">{p.outcome.judged} 件は判定済みで、一覧に反映しています。</p>}
            </>
          ) : (
            <>
              <h3>
                {p.outcome.stopped ? "途中で中止しました" : "AI 判定が終わりました"}（{p.outcome.judged} 件）
              </h3>
              {p.outcome.missing > 0 && <p className="muted small">{p.outcome.missing} 件は AI の応答に含まれていなかったため、元 CLI の判定のままです。</p>}
            </>
          )}
          {p.summary.all.count > 0 && (
            <div className="stats compact">
              {(["safe", "caution", "keep"] as const).map((b) => (
                <div key={b} className={`stat ${b}`}>
                  <span className="stat-label">{AI_VERDICT_JA[b]}</span>
                  <span className="stat-value">{p.summary[b].count} 件</span>
                  <span className="stat-sub">{formatBytes(p.summary[b].size)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="muted small">保護リストと元 CLI のルールが常に優先されます。AI が「削除していい」と言っても、個人データや使用中のデータは「注意」に下げています。</p>
        </div>
      )}

      {!p.signedIn ? (
        <div className="callout">
          <strong>ChatGPT にサインインすると使えます。</strong>右の「ChatGPT プランを使う」からサインインしてください。AI を使わずに次へ進むこともできます。
        </div>
      ) : !p.planReady ? (
        <div className="callout warn-box">このアカウントでは ChatGPT プランの利用が許可されていません。右のパネルから有効にできます。</div>
      ) : p.modelsLoading ? (
        <div className="callout row">
          <span className="spinner tiny-spin" /> モデル一覧を取得しています…
        </div>
      ) : !p.modelName ? (
        <div className="callout warn-box">モデル一覧を取得できていません。右のパネルの「再読み込み」を試してください。</div>
      ) : (
        <div className="callout">
          <div>
            対象 <strong>{p.targets} 件</strong>（保護されている項目は送りません）・{batches} 回に分けて送信・モデル <strong>{p.modelName}</strong>
          </div>
        </div>
      )}

      <div className="step-actions">
        {p.outcome ? (
          <>
            <button type="button" onClick={p.onOpenSend} disabled={!p.planReady || !p.modelName || p.targets === 0}>
              もう一度判定する…
            </button>
            <button type="button" onClick={p.onGoTrash} disabled={p.selectedCount === 0} title={p.selectedCount === 0 ? "一覧で項目を選ぶと進めます" : undefined}>
              ゴミ箱へ移動の確認へ（{p.selectedCount} 件）
            </button>
            <button type="button" className="primary large" onClick={p.onGoReview}>
              結果を一覧で確認する →
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={p.onGoReview}>
              ← 一覧に戻る
            </button>
            <button type="button" onClick={p.onGoTrash} disabled={p.selectedCount === 0} title={p.selectedCount === 0 ? "一覧で項目を選ぶと進めます" : undefined}>
              AI を使わずにゴミ箱へ移動の確認へ（{p.selectedCount} 件）
            </button>
            <button type="button" className="primary large" onClick={p.onOpenSend} disabled={!p.planReady || !p.modelName || p.targets === 0}>
              送信内容を確認する…
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function AiRunning({ run, destination, onStop }: { run: AiRun; destination: string; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="step-page">
      <LoadingPanel
        title={run.stopRequested ? "このバッチが終わったら中止します…" : "AI が判定しています"}
        footer={
          <>
            <span className="muted small">経過 {elapsedJa(now - run.startedAt)}</span>
            <button type="button" onClick={onStop} disabled={run.stopRequested}>
              {run.stopRequested ? "中止を待っています…" : "中止（このバッチの後）"}
            </button>
          </>
        }
      >
        <div className="row space small">
          <span>
            判定済み <strong>{run.done}</strong> / {run.total} 件
          </span>
          <span className="muted">
            バッチ {Math.min(run.batch, run.batches)} / {run.batches}
          </span>
        </div>
        <ProgressBar value={ratio(run.done, run.total)} label="判定済みの件数" />
        <div className="stream-line">
          <span className={`pulse ${run.chars > 0 ? "live" : ""}`} aria-hidden="true" />
          {run.chars > 0 ? (
            <span>
              応答を受信中… <span className="num">{run.chars.toLocaleString()}</span> 文字
            </span>
          ) : (
            <span className="muted">{destination} の応答を待っています…</span>
          )}
        </div>
        <p className="muted small">送っているのはメタデータだけです。結果はバッチごとに一覧へ反映されます。</p>
      </LoadingPanel>
    </section>
  );
}
