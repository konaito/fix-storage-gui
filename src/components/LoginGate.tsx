import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isSiwcError } from "../lib/api";
import { describeError } from "../lib/errors";
import { gateReducer, gateView, initialGate, ruleOnlyChoice, singleFlight, type SiwcChanged } from "../lib/gate";
import { GateContext, type GateState, type SignInResult } from "./GateContext";
import { LoginScreen } from "./LoginScreen";

/**
 * Sign in with ChatGPT is required: nothing inside `children` is rendered until the
 * active account is signed in (tokens in the Keychain) and ChatGPT plan usage is allowed.
 * The gate follows sign-in / sign-out / account switches / tokens that stopped working through the
 * `siwc-changed` event, and is the only owner of the sign-in state: the wrapped app reads `status`
 * and `signingIn` and starts sign-ins through `GateContext` (#29, #30).
 *
 * If the account did not allow ChatGPT plan usage, the user may continue in rule-only mode
 * (original CLI rules + hard block); `GateContext.planEnabled` is then false and AI is off.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [gate, dispatch] = useReducer(gateReducer, initialGate);
  const { status, loadError, signingIn, error, notice, statusVersion } = gate;
  // Per-session copy of the remembered "continue without plan usage" choices.
  const [ruleOnly, setRuleOnly] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: "loaded", status: await api.siwcStatus() });
    } catch (e) {
      dispatch({ type: "loadFailed", message: describeError(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const un = listen<SiwcChanged>("siwc-changed", (e) => {
      dispatch({ type: "changed", event: e.payload });
      if (e.payload.reason === "signed_out") {
        // Ask again next time instead of silently entering rule-only mode.
        ruleOnlyChoice.clearAll();
        setRuleOnly({});
      }
      void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // One sign-in at a time for the whole window, wherever the button was (#30).
  const runSignIn = useRef(
    singleFlight(async (clientId: string | null, promptConsent: boolean) => {
      dispatch({ type: "signInStart" });
      try {
        return { account: await api.siwcSignIn(clientId, promptConsent), error: null as unknown };
      } catch (e) {
        return { account: null, error: e };
      } finally {
        dispatch({ type: "signInEnd" });
        await refresh();
      }
    }),
  ).current;

  const signIn = useCallback(
    async (clientId: string | null, promptConsent: boolean): Promise<SignInResult> => {
      const r = await runSignIn(clientId, promptConsent);
      return r.started ? { started: true, ...r.value } : r;
    },
    [runSignIn],
  );

  /** Sign-in from the login screen or the rule-only bar: the error is shown there. */
  async function signInHere(clientId: string | null, promptConsent: boolean) {
    const r = await signIn(clientId, promptConsent);
    if (r.started && r.error) {
      dispatch({ type: "error", error: { message: describeError(r.error), cancelled: isSiwcError(r.error) && r.error.kind === "cancelled" } });
    }
  }

  const signOut = useCallback(async (): Promise<unknown> => {
    try {
      await api.siwcSignOut(); // the siwc-changed event sets the notice and refreshes
      return null;
    } catch (e) {
      dispatch({ type: "error", error: { message: describeError(e), cancelled: false } });
      await refresh();
      return e;
    }
  }, [refresh]);

  const switchAccount = useCallback(
    async (clientId: string): Promise<unknown> => {
      try {
        await api.siwcSwitch(clientId); // the siwc-changed event refreshes
        return null;
      } catch (e) {
        await refresh();
        return e;
      }
    },
    [refresh],
  );

  const cancelSignIn = useCallback(() => void api.siwcCancelSignIn(), []);

  const view = gateView(status, loadError);

  const continuesWithoutPlan =
    view.kind === "plan_disabled" && (ruleOnly[view.account.clientId] ?? ruleOnlyChoice.get(view.account.clientId));

  if (view.kind === "ready" || (view.kind === "plan_disabled" && continuesWithoutPlan)) {
    const account = view.account;
    const enablePlan = () => void signInHere(account.clientId, true);
    const value: GateState = {
      status,
      planEnabled: view.kind === "ready",
      ruleOnly: view.kind !== "ready",
      statusVersion,
      signingIn,
      signIn,
      cancelSignIn,
      signOut,
      switchAccount,
      refreshStatus: refresh,
      enablePlan,
    };
    return (
      <GateContext.Provider value={value}>
        <div className="gate-shell">
        {view.kind === "plan_disabled" && (
          <RuleOnlyBar
            label={account.label}
            signingIn={signingIn}
            error={error?.message ?? null}
            onEnable={enablePlan}
            onCancel={cancelSignIn}
            onDismissError={() => dispatch({ type: "error", error: null })}
          />
        )}
        {children}
        </div>
      </GateContext.Provider>
    );
  }

  return (
    <LoginScreen
      view={view}
      saved={status?.accounts ?? []}
      signingIn={signingIn}
      error={error}
      notice={notice}
      onSignIn={(id, consent) => void signInHere(id, consent)}
      onCancelSignIn={cancelSignIn}
      onReload={() => {
        dispatch({ type: "reload" });
        void refresh();
      }}
      onSignOut={() => void signOut()}
      onContinueWithoutPlan={(clientId) => {
        ruleOnlyChoice.set(clientId, true);
        dispatch({ type: "error", error: null });
        setRuleOnly((r) => ({ ...r, [clientId]: true }));
      }}
      onDismissNotice={() => dispatch({ type: "dismissNotice" })}
      onOpenDoc={(url) => void api.openSiwcDoc(url).catch((e) => dispatch({ type: "error", error: { message: describeError(e), cancelled: false } }))}
      onManageUsage={() => void api.openUsage()}
    />
  );
}

function RuleOnlyBar(p: {
  label: string;
  signingIn: boolean;
  error: string | null;
  onEnable: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}) {
  return (
    <div className="rule-only-bar" role="status">
      <span className="rule-only-text">
        <strong>ルール判定のみモード</strong>
        <span className="muted">（{p.label}）</span>
        <span
          className="muted rule-only-desc"
          title="このアカウントは ChatGPT プランの使用を許可していないため、AI 判定はオフです。判定は元 CLI のルールとハードブロックだけで行い、OpenAI には何も送りません。"
        >
          AI 判定はオフです。OpenAI には何も送りません。
        </span>
        {p.error && (
          <span className="warn">
            {p.error} <button className="link" onClick={p.onDismissError}>閉じる</button>
          </span>
        )}
      </span>
      {p.signingIn ? (
        <span className="row">
          <span className="spinner tiny-spin" aria-hidden="true" />
          <span className="small">ブラウザで許可してください…</span>
          <button className="small-btn" onClick={p.onCancel}>中止</button>
        </span>
      ) : (
        <button className="chatgpt-button small-btn" onClick={p.onEnable}>
          ChatGPT プランの利用を有効にする
        </button>
      )}
    </div>
  );
}
