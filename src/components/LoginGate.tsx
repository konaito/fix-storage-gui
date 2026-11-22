import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isSiwcError } from "../lib/api";
import { describeError } from "../lib/errors";
import { gateReducer, gateScreen, initialGate, ruleOnlyChoice, singleFlight, type SiwcChanged } from "../lib/gate";
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
 *
 * If a token stops working while the app holds a scan result, the app stays mounted (results and AI
 * verdicts kept, shown with the rules only) under a bar to sign in again (#75).
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [gate, dispatch] = useReducer(gateReducer, initialGate);
  const { status, signingIn, error, notice, statusVersion } = gate;
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

  const reportApp = useCallback((hasResults: boolean, busy: string | null) => dispatch({ type: "app", hasResults, busy }), []);

  const screen = gateScreen(gate, (clientId) => ruleOnly[clientId] ?? ruleOnlyChoice.get(clientId));

  if (screen.kind === "app") {
    const { account, bar } = screen;
    const enablePlan = () => {
      if (account) void signInHere(account.clientId, true);
    };
    const value: GateState = {
      status,
      planEnabled: screen.planEnabled,
      ruleOnly: bar?.kind === "rule_only",
      statusVersion,
      signingIn,
      signIn,
      cancelSignIn,
      signOut,
      switchAccount,
      refreshStatus: refresh,
      enablePlan,
      reportApp,
    };
    return (
      <GateContext.Provider value={value}>
        <div className="gate-shell">
        {bar?.kind === "rule_only" && (
          <RuleOnlyBar
            label={bar.account.label}
            signingIn={signingIn}
            error={error?.message ?? null}
            onEnable={enablePlan}
            onCancel={cancelSignIn}
            onDismissError={() => dispatch({ type: "error", error: null })}
          />
        )}
        {bar?.kind === "reauth" && (
          <ReauthBar
            reason={bar.reason}
            label={bar.account?.label ?? null}
            busy={gate.appBusy}
            signingIn={signingIn}
            error={error?.message ?? null}
            onSignIn={() => void signInHere(bar.target, false)}
            onCancel={cancelSignIn}
            onDismissError={() => dispatch({ type: "error", error: null })}
          />
        )}
        {children}
        </div>
      </GateContext.Provider>
    );
  }

  const view = screen.view;

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

/** Shown above the app when a token stopped working while it held results (#75). */
function ReauthBar(p: {
  reason: "reauth" | "client_revoked";
  label: string | null;
  busy: string | null;
  signingIn: boolean;
  error: string | null;
  onSignIn: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}) {
  return (
    <div className="rule-only-bar" role="alert">
      <span className="rule-only-text">
        <strong>{p.reason === "reauth" ? "ChatGPT へのサインインが使えなくなりました" : "このアプリの登録が ChatGPT 側で使えなくなりました"}</strong>
        {p.label && <span className="muted">（{p.label}）</span>}
        <span className="muted">
          スキャン結果と AI の判定は残しています。いまはルール判定だけで表示しています。サインインし直すと、未判定の分だけ AI 判定を続けられます。
        </span>
        {p.busy && <span className="muted">{p.busy}が終わるとサインインできます。</span>}
        {p.error && (
          <span className="warn">
            {p.error} <button className="link" onClick={p.onDismissError}>閉じる</button>
          </span>
        )}
      </span>
      {p.signingIn ? (
        <span className="row">
          <span className="spinner tiny-spin" aria-hidden="true" />
          <span className="small">ブラウザでサインインしてください…</span>
          <button className="small-btn" onClick={p.onCancel}>中止</button>
        </span>
      ) : (
        <button className="chatgpt-button small-btn" onClick={p.onSignIn} disabled={!!p.busy}>
          {p.reason === "reauth" ? "サインインし直す" : "もう一度サインインする"}
        </button>
      )}
    </div>
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
