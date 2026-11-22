import { stepAriaLabel } from "../flow/a11y";
import { stepStatus, stepsFor, type FlowState, type StepId } from "../flow/steps";

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
        {stepsFor(flow.aiFirst).map((s) => {
          const st = stepStatus(flow, s.id);
          const clickable = st !== "current" && canGo(s.id);
          const busyHere = st === "current" && flow.busy !== null;
          return (
            <li key={s.id} className={`step ${st}${clickable ? " clickable" : ""}`}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onGo(s.id)}
                aria-current={st === "current" ? "step" : undefined}
                aria-label={stepAriaLabel(s.label, st, s.id === "ai" && !flow.aiFirst, busyHere)}
                title={clickable ? `「${s.label}」に戻る` : s.label}
              >
                <span className="dot" aria-hidden="true">
                  {busyHere ? <span className="spinner tiny-spin" /> : st === "done" ? "✓" : st === "skipped" ? "–" : s.n}
                </span>
                <span className="step-label" aria-hidden="true">
                  <span className="step-label-full">{s.label}</span>
                  <span className="step-label-short">{s.shortLabel}</span>
                  {s.id === "ai" && !flow.aiFirst && <span className="opt">{st === "skipped" ? "スキップ" : "任意"}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
