import { createContext, useContext } from "react";
import type { AccountView, SiwcStatus } from "../lib/api";

/** Result of a sign-in started through the gate. `started: false` means one was already running (#30). */
export type SignInResult = { started: false } | { started: true; account: AccountView | null; error: unknown };

/**
 * What the login gate tells the app it wraps. The gate is the only owner of the sign-in state
 * (#29, #30): the app reads `status` and `signingIn` from here instead of keeping its own copy.
 */
export interface GateState {
  /** Latest `siwc_status`. Inside the gate this is never null. */
  status: SiwcStatus | null;
  /** True only when the active account granted ChatGPT plan usage. AI judgement must not run otherwise. */
  planEnabled: boolean;
  /** Signed in, but continuing without ChatGPT plan usage (original CLI rules + hard block only). */
  ruleOnly: boolean;
  /** Increments whenever sign-in state changes (sign-in, sign-out, switch, re-consent, reauth). */
  statusVersion: number;
  /** A browser sign-in is waiting, wherever it was started. */
  signingIn: boolean;
  /** Starts a browser sign-in unless one is already running. Errors are returned, not shown. */
  signIn: (clientId: string | null, promptConsent: boolean) => Promise<SignInResult>;
  cancelSignIn: () => void;
  /** Signs out of every account. Returns the error, if any. */
  signOut: () => Promise<unknown>;
  switchAccount: (clientId: string) => Promise<unknown>;
  refreshStatus: () => Promise<void>;
  /** Opens the browser to allow ChatGPT plan usage for the active account. */
  enablePlan: () => void;
}

const noop = async () => null;

export const GateContext = createContext<GateState>({
  status: null,
  planEnabled: false,
  ruleOnly: false,
  statusVersion: 0,
  signingIn: false,
  signIn: async () => ({ started: false }),
  cancelSignIn: () => {},
  signOut: noop,
  switchAccount: noop,
  refreshStatus: async () => {},
  enablePlan: () => {},
});

export function useGate(): GateState {
  return useContext(GateContext);
}
