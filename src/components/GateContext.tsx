import { createContext, useContext } from "react";

/** What the login gate tells the app it wraps. */
export interface GateState {
  /** True only when the active account granted ChatGPT plan usage. AI judgement must not run otherwise. */
  planEnabled: boolean;
  /** Signed in, but continuing without ChatGPT plan usage (original CLI rules + hard block only). */
  ruleOnly: boolean;
  /** Increments whenever sign-in state changes (sign-in, sign-out, switch, re-consent). */
  statusVersion: number;
  /** Opens the browser to allow ChatGPT plan usage for the active account. */
  enablePlan: () => void;
}

export const GateContext = createContext<GateState>({ planEnabled: false, ruleOnly: false, statusVersion: 0, enablePlan: () => {} });

export function useGate(): GateState {
  return useContext(GateContext);
}
