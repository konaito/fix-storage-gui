import { StepBar } from "../ActionBar";
import { useEffect, useState } from "react";
import { elapsedJa, phaseStates, ratio, SCAN_PHASES } from "../../flow/progress";
import type { ScanProgress } from "../../lib/api";
import { CurrentPath, LoadingPanel, ProgressBar } from "../Loader";
import type { Target } from "./TargetStep";

interface Props {
  target: Target;
  progress: ScanProgress | null;
  startedAt: number;
  cancelling: boolean;
  onCancel: () => void;
}

export function ScanningStep({ target, progress, startedAt, cancelling, onCancel }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const phase = progress?.phase ?? null;
  const states = phaseStates(phase);
  const slow = now - startedAt > 20_000;

  return (
    <section className="step-page">
      <StepBar
        eyebrow="ステップ 2"
        busy
        title={cancelling ? "中止しています…" : target.kind === "mac" ? "Mac 全体をスキャンしています" : "フォルダをスキャンしています"}
        desc="サイズを計測しています。すべてこの Mac の中で行います。"
        meta={<span className="num">経過 {elapsedJa(now - startedAt)}</span>}
      >
        <button type="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "中止しています…" : "中止（途中までの結果を表示）"}
        </button>
      </StepBar>
      <LoadingPanel>
        {target.kind === "folder" && <CurrentPath path={target.path} />}
        <ol className="phase-list">
          {SCAN_PHASES.map((ph) => {
            const st = states[ph.id];
            const active = st === "active";
            const value = active && progress && progress.phase === ph.id ? ratio(progress.done, progress.total) : null;
            return (
              <li key={ph.id} className={`phase ${st}`}>
                <span className="phase-dot" aria-hidden="true">
                  {st === "done" ? "✓" : active ? <span className="spinner tiny-spin" /> : ""}
                </span>
                <div className="phase-body">
                  <div className="row space">
                    <span className="phase-title">{ph.label}</span>
                    {active && progress && progress.phase === ph.id && (
                      <span className="muted small num">
                        {ph.id === "listing" ? `${progress.done.toLocaleString()} 件見つかりました` : `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} 件`}
                      </span>
                    )}
                  </div>
                  {active && (
                    <>
                      <ProgressBar value={value} label={ph.label} />
                      {progress && progress.phase === ph.id && <CurrentPath path={progress.current} />}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <p className="muted small">
          進み具合はフォルダの「件数」で数えています（サイズの割合ではありません）。大きなフォルダの計測には時間がかかることがあります。
        </p>
        {slow && (
          <p className="hint small">
            macOS が「〜へのアクセスを許可しますか？」と尋ねてきたら、許可するか拒否してください。応答がないフォルダは数秒で「読めなかったフォルダ」として飛ばします。
          </p>
        )}
      </LoadingPanel>
    </section>
  );
}
