/**
 * The whole flow as separate steps, as a small pure state machine (unit-tested in test/steps.test.ts).
 * 1 スキャン対象を選ぶ → 2 スキャン中 → 3 一覧を確認 → 4 AI 判定（任意）→ 5 ゴミ箱へ移動の確認 → 6 完了
 */

export type StepId = "target" | "scanning" | "review" | "ai" | "trash" | "done";
export type Busy = "scan" | "ai" | "trash" | null;

export interface StepDef {
  id: StepId;
  n: number;
  label: string;
}

export const STEPS: StepDef[] = [
  { id: "target", n: 1, label: "スキャン対象を選ぶ" },
  { id: "scanning", n: 2, label: "スキャン中" },
  { id: "review", n: 3, label: "一覧を確認" },
  { id: "ai", n: 4, label: "AI 判定" },
  { id: "trash", n: 5, label: "ゴミ箱へ移動の確認" },
  { id: "done", n: 6, label: "完了" },
];

export interface FlowState {
  step: StepId;
  busy: Busy;
  /** A scan has finished at least once, so there is a list to go back to. */
  hasScan: boolean;
  /** AI judgement finished for the current list (at least partly). */
  aiDone: boolean;
  /** Where "戻る" from the trash step goes. */
  trashFrom: "review" | "ai";
}

export const initialFlow: FlowState = { step: "target", busy: null, hasScan: false, aiDone: false, trashFrom: "review" };

export type FlowEvent =
  | { type: "scanStart" }
  | { type: "scanEnd"; ok: boolean }
  | { type: "go"; to: StepId; selected: number }
  | { type: "back"; selected: number }
  | { type: "aiStart" }
  | { type: "aiEnd"; ok: boolean }
  | { type: "trashStart" }
  | { type: "trashEnd" }
  | { type: "reset" };

const index = (id: StepId) => STEPS.findIndex((s) => s.id === id);

/** Whether the user may jump to `to` (stepper click / buttons). Never while something is running. */
export function canGo(s: FlowState, to: StepId, selected: number): boolean {
  if (s.busy) return false;
  switch (to) {
    case "target":
      return true;
    case "review":
    case "ai":
      return s.hasScan;
    case "trash":
      return s.hasScan && selected > 0;
    // Only reachable by running a scan / finishing the trash move.
    case "scanning":
    case "done":
      return false;
  }
}

/** The step "戻る" leads to, or null when there is none (or something is running). */
export function backTarget(s: FlowState): StepId | null {
  if (s.busy) return null;
  switch (s.step) {
    case "review":
    case "scanning":
      return "target";
    case "ai":
      return "review";
    case "trash":
      return s.trashFrom;
    case "done":
      return "review";
    default:
      return null;
  }
}

export function flowReducer(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case "scanStart":
      if (s.busy) return s;
      return { ...s, step: "scanning", busy: "scan" };
    case "scanEnd":
      if (s.busy !== "scan") return s;
      // A failed scan goes back to the previous list if there is one, otherwise to the target step (the error is shown there).
      return e.ok
        ? { ...s, step: "review", busy: null, hasScan: true, aiDone: false }
        : { ...s, step: s.hasScan ? "review" : "target", busy: null };
    case "go": {
      if (s.step === e.to || !canGo(s, e.to, e.selected)) return s;
      const trashFrom = e.to === "trash" ? (s.step === "ai" ? "ai" : "review") : s.trashFrom;
      return { ...s, step: e.to, trashFrom };
    }
    case "back": {
      const to = backTarget(s);
      if (!to) return s;
      if (to === "ai" || to === "review") return s.hasScan ? { ...s, step: to } : { ...s, step: "target" };
      return { ...s, step: to };
    }
    case "aiStart":
      if (s.busy || !s.hasScan) return s;
      return { ...s, step: "ai", busy: "ai" };
    case "aiEnd":
      if (s.busy !== "ai") return s;
      return { ...s, busy: null, aiDone: s.aiDone || e.ok };
    case "trashStart":
      if (s.busy || s.step !== "trash") return s;
      return { ...s, busy: "trash" };
    case "trashEnd":
      if (s.busy !== "trash") return s;
      return { ...s, step: "done", busy: null };
    case "reset":
      return s.busy ? s : { ...initialFlow };
  }
}

export type StepStatus = "done" | "current" | "upcoming" | "skipped";

/** How a step looks in the progress indicator. Step 4 (AI) is optional and shows as skipped when passed over. */
export function stepStatus(s: FlowState, id: StepId): StepStatus {
  const cur = index(s.step);
  const i = index(id);
  if (i === cur) return "current";
  if (id === "ai" && s.aiDone) return "done";
  if (i < cur) return id === "ai" && !s.aiDone ? "skipped" : "done";
  // Going back to review after a finished trash keeps earlier work visible as done.
  if (id === "scanning" && s.hasScan) return "done";
  return "upcoming";
}
