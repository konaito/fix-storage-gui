import { STEPS, stepStatus, type FlowState, type StepId } from "../flow/steps";

interface Props {
  flow: FlowState;
  canGo: (to: StepId) => boolean;
  onGo: (to: StepId) => void;
}

/** Progress indicator across the six steps. Finished steps can be clicked to go back when allowed. */
export function Stepper({ flow, canGo, onGo }: Props) {
  return (
    <nav className="stepper" aria-label="進み具合">
      <ol>
        {STEPS.map((s) => {
          const st = stepStatus(flow, s.id);
          const clickable = st !== "current" && canGo(s.id);
          const busyHere = st === "current" && flow.busy !== null;
          return (
            <li key={s.id} className={`step ${st}${clickable ? " clickable" : ""}`} aria-current={st === "current" ? "step" : undefined}>
              <button type="button" disabled={!clickable} onClick={() => onGo(s.id)} title={clickable ? `「${s.label}」に戻る` : undefined}>
                <span className="dot" aria-hidden="true">
                  {busyHere ? <span className="spinner tiny-spin" /> : st === "done" ? "✓" : st === "skipped" ? "–" : s.n}
                </span>
                <span className="step-label">
                  {s.label}
                  {s.id === "ai" && <span className="opt">{st === "skipped" ? "スキップ" : "任意"}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
