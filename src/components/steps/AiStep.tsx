import { useEffect, useState } from "react";
import { DEFAULT_CONCURRENCY } from "../../ai/runBatches";
import { elapsedJa, ratio, type Bucket, type VerdictSummary } from "../../flow/progress";
import { stepNo } from "../../flow/steps";
import { formatBytes } from "../../lib/format";
import { AI_VERDICT_JA } from "../../lib/labels";
import { StepBar } from "../ActionBar";
import { LoadingPanel, ProgressBar } from "../Loader";

export interface AiRun {
  done: number;
  total: number;
  batchesInFlight: number;
  batchesCompleted: number;
  batches: number;
  chars: number;
  startedAt: number;
  stopRequested: boolean;
}

export interface AiOutcome {
  judged: number;
  missing: number;
  /** Items in batches that failed even after one retry; they stay unjudged (#27). */
  failed: number;
  failedReason: string | null;
  stopped: boolean;
  error: string | null;
}

interface Props {
  /** The user uses AI judgement: this step comes before the list and is not optional (#12). */
  aiFirst: boolean;
  /** Whether the list step can be opened (with aiFirst, only after an AI run). */
  canGoReview: boolean;
  /** "戻る" (to the target step when aiFirst). */
  onBack: () => void;
  planReady: boolean;
  signedIn: boolean;
  modelName: string | null;
  modelsLoading: boolean;
  destination: string;
  /** Targets the AI has not judged yet: what the next run sends. */
  targets: number;
  batchSize: number;
  running: AiRun | null;
  outcome: AiOutcome | null;
  summary: Record<Bucket | "all", VerdictSummary>;
  selectedCount: number;
  onOpenSend: () => void;
  /** Re-consent to ChatGPT plan usage (from the login gate). */
  onStop: () => void;
  onGoReview: () => void;
  onGoTrash: () => void;
}

export function AiStep(p: Props) {
  if (p.running) return <AiRunning run={p.running} eyebrow={eyebrowOf(p.aiFirst)} destination={p.destination} onStop={p.onStop} />;
  const batches = Math.ceil(p.targets / p.batchSize);

  return (
    <section className="step-page">
      <StepBar
        eyebrow={eyebrowOf(p.aiFirst)}
        title={p.outcome ? (p.outcome.error ? "AI 判定を完了できませんでした" : p.outcome.stopped ? "AI 判定を途中で中止しました" : "AI 判定が終わりました") : "AI に判定してもらう"}
        desc={
          <>
            ファイル名・サイズ・日付などの<strong>メタデータだけ</strong>を {p.destination} に送ります。ファイルの中身は送りません。
          </>
        }
      >
        {p.outcome ? (
          <>
            <button
              type="button"
              onClick={p.onOpenSend}
              disabled={!(p.planReady && !!p.modelName && p.targets > 0)}
              title={p.targets === 0 ? "未判定の項目はありません" : `未判定の ${p.targets} 件だけを送ります`}
            >
              もう一度判定する（未判定 {p.targets} 件）…
            </button>
            <button type="button" className="primary large" onClick={p.onGoReview} disabled={!p.canGoReview}>
              結果を一覧で確認する →
            </button>
          </>
        ) : p.planReady && !!p.modelName && p.targets > 0 ? (
          <>
            {p.aiFirst ? (
              <button type="button" onClick={p.onBack}>
                ← 対象を変える
              </button>
            ) : (
              <button type="button" onClick={p.onGoReview}>
                ← 一覧に戻る
              </button>
            )}
            <button type="button" className="primary large" onClick={p.onOpenSend}>
              送信内容を確認する…
            </button>
          </>
        ) : p.aiFirst ? (
          <>
            <button type="button" onClick={p.onBack}>
              ← 対象を変える
            </button>
            {p.canGoReview && (
              <button type="button" className="primary large" onClick={p.onGoReview}>
                一覧へ →
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" onClick={p.onGoTrash} disabled={p.selectedCount === 0} title={p.selectedCount === 0 ? "一覧で項目を選ぶと進めます" : undefined}>
              AI なしでゴミ箱の確認へ（{p.selectedCount} 件）
            </button>
            <button type="button" className="primary large" onClick={p.onGoReview}>
              ← 一覧に戻る
            </button>
          </>
        )}
      </StepBar>
      {!p.outcome && p.planReady && (
        <p className="muted small lead">
          {p.aiFirst && "一覧は AI の判定が終わってから開きます。"}
          送る前に、実際に送る内容（JSON）をすべて確認できます。AI の判定は参考で、保護リストと元 CLI のルールが常に優先されます。
        </p>
      )}

      {p.outcome && (
        <div className={`result-card ${p.outcome.error ? "error-card" : ""}`}>
          {p.outcome.error ? (
            <>
              <p>{p.outcome.error}</p>
              {p.outcome.judged > 0 && <p className="muted small">{p.outcome.judged} 件は判定済みで、一覧に反映しています。</p>}
              {p.outcome.failed > 0 && <FailedNote count={p.outcome.failed} reason={p.outcome.failedReason} />}
              {p.aiFirst && <p className="muted small">AI が判定していない項目は「未判定」になり、選べません。</p>}
            </>
          ) : (
            <>
              <h3>{p.outcome.judged} 件を判定しました</h3>
              {p.outcome.missing > 0 && (
                <p className="muted small">
                  {p.outcome.missing} 件は AI の応答に含まれていなかったため、
                  {p.aiFirst ? "「未判定」のままで、選べません。" : "元 CLI の判定のままです。"}
                </p>
              )}
              {p.outcome.failed > 0 && <FailedNote count={p.outcome.failed} reason={p.outcome.failedReason} />}
              {p.outcome.stopped && p.aiFirst && <p className="muted small">中止までに判定できなかった項目は「未判定」のままで、選べません。</p>}
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
          <strong>ChatGPT にサインインすると使えます。</strong>右の「ChatGPT プランを使う」からサインインしてください。AI を使わずに一覧へ戻ることもできます。
        </div>
      ) : !p.planReady ? (
        <div className="callout warn-box">
          <p>
            <strong>ルール判定のみモードです。</strong>このアカウントでは ChatGPT プランの使用が許可されていないため、AI 判定はオフです。OpenAI
            には何も送りません。判定は元 CLI のルールとハードブロックだけで行っています。このステップは飛ばして、そのまま一覧やゴミ箱へ移動の確認に進めます。
          </p>
          <p className="small">AI 判定を使うには、画面上部のバーの「ChatGPT プランの利用を有効にする」から許可してください。</p>
        </div>
      ) : p.modelsLoading ? (
        <div className="callout row">
          <span className="spinner tiny-spin" /> モデル一覧を取得しています…
        </div>
      ) : !p.modelName ? (
        <div className="callout warn-box">モデル一覧を取得できていません。右のパネルの「再読み込み」を試してください。</div>
      ) : p.targets === 0 ? (
        <div className="callout">未判定の項目はありません。</div>
      ) : (
        <div className="callout">
          <div>
            対象 <strong>{p.targets} 件</strong>（判定済みと保護されている項目は送りません）・{batches} 回に分け、最大 {DEFAULT_CONCURRENCY} 件まで同時に送信・モデル{" "}
            <strong>{p.modelName}</strong>
          </div>
        </div>
      )}

    </section>
  );
}

function FailedNote({ count, reason }: { count: number; reason: string | null }) {
  return (
    <p className="muted small">
      {count} 件は 2 回送っても応答を読めなかったため、「未判定」のままです。「もう一度判定する」で未判定の分だけを送り直せます。
      {reason && `（${reason}）`}
    </p>
  );
}

function eyebrowOf(aiFirst: boolean): string {
  return `ステップ ${stepNo(aiFirst, "ai")}${aiFirst ? "" : "（任意）"}`;
}

function AiRunning({ run, eyebrow, destination, onStop }: { run: AiRun; eyebrow: string; destination: string; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="step-page">
      <StepBar
        eyebrow={eyebrow}
        busy
        title={run.stopRequested ? "中止しています…" : "AI が判定しています"}
        desc="送っているのはメタデータだけです。結果はバッチごとに一覧へ反映されます。"
        meta={
          <span className="num">
            {run.done} / {run.total} 件・経過 {elapsedJa(now - run.startedAt)}
          </span>
        }
      >
        <button type="button" onClick={onStop} disabled={run.stopRequested}>
          {run.stopRequested ? "中止しています…" : "中止"}
        </button>
      </StepBar>
      <LoadingPanel>
        <div className="row space small">
          <span>
            判定済み <strong>{run.done}</strong> / {run.total} 件
          </span>
          <span className="muted">
            完了 {run.batchesCompleted} / {run.batches} バッチ
            {run.batchesInFlight > 0 ? `（送信中 ${run.batchesInFlight}）` : ""}
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
      </LoadingPanel>
    </section>
  );
}
