import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isSiwcError, type SiwcStatus } from "../lib/api";
import { describeError } from "../lib/errors";
import { gateView, ruleOnlyChoice } from "../lib/gate";
import { GateContext } from "./GateContext";
import { LoginScreen } from "./LoginScreen";

interface SiwcChanged {
  reason: "signed_in" | "signed_out" | "switched";
  remoteRevoked: boolean | null;
}

type Attempt = { clientId: string | null; promptConsent: boolean };

/**
 * Sign in with ChatGPT is required: nothing inside `children` is rendered until the
 * active account is signed in (tokens in the Keychain) and ChatGPT plan usage is allowed.
 * The gate follows sign-in / sign-out / account switches through the `siwc-changed` event,
 * so the wrapped app does not need to know about it.
 *
 * If the account did not allow ChatGPT plan usage, the user may continue in rule-only mode
 * (original CLI rules + hard block); `GateContext.planEnabled` is then false and AI is off.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SiwcStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<{ message: string; cancelled: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastAttempt = useRef<Attempt>({ clientId: null, promptConsent: false });
  const [statusVersion, setStatusVersion] = useState(0);
  // Per-session copy of the remembered "continue without plan usage" choices.
  const [ruleOnly, setRuleOnly] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.siwcStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const un = listen<SiwcChanged>("siwc-changed", (e) => {
      setStatusVersion((v) => v + 1);
      if (e.payload.reason === "signed_out") {
        // Ask again next time instead of silently entering rule-only mode.
        ruleOnlyChoice.clearAll();
        setRuleOnly({});
        setError(null);
        setNotice(
          e.payload.remoteRevoked === false
            ? "サインアウトしました。この Mac のトークンは消しましたが、ChatGPT 側での接続解除を確認できませんでした。必要なら ChatGPT の設定からこのアプリの接続を解除してください。"
            : "サインアウトしました。",
        );
      }
      void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  async function signIn(clientId: string | null, promptConsent: boolean) {
    lastAttempt.current = { clientId, promptConsent };
    setError(null);
    setNotice(null);
    setSigningIn(true);
    try {
      await api.siwcSignIn(clientId, promptConsent);
    } catch (e) {
      setError({ message: describeError(e), cancelled: isSiwcError(e) && e.kind === "cancelled" });
    } finally {
      setSigningIn(false);
      await refresh();
    }
  }

  async function signOut() {
    try {
      await api.siwcSignOut(); // the siwc-changed event sets the notice and refreshes
    } catch (e) {
      setError({ message: describeError(e), cancelled: false });
      await refresh();
    }
  }

  const view = gateView(status, loadError);

  const continuesWithoutPlan =
    view.kind === "plan_disabled" && (ruleOnly[view.account.clientId] ?? ruleOnlyChoice.get(view.account.clientId));

  if (view.kind === "ready" || (view.kind === "plan_disabled" && continuesWithoutPlan)) {
    const account = view.account;
    const enablePlan = () => void signIn(account.clientId, true);
    return (
      <GateContext.Provider value={{ planEnabled: view.kind === "ready", ruleOnly: view.kind !== "ready", statusVersion, enablePlan }}>
        {view.kind === "plan_disabled" && (
          <RuleOnlyBar
            label={account.label}
            signingIn={signingIn}
            error={error?.message ?? null}
            onEnable={enablePlan}
            onCancel={() => void api.siwcCancelSignIn()}
            onDismissError={() => setError(null)}
          />
        )}
        {children}
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
      onSignIn={(id, consent) => void signIn(id, consent)}
      onRetry={() => void signIn(lastAttempt.current.clientId, lastAttempt.current.promptConsent)}
      onCancelSignIn={() => void api.siwcCancelSignIn()}
      onReload={() => {
        setLoadError(null);
        setStatus(null);
        void refresh();
      }}
      onSignOut={() => void signOut()}
      onContinueWithoutPlan={(clientId) => {
        ruleOnlyChoice.set(clientId, true);
        setError(null);
        setRuleOnly((r) => ({ ...r, [clientId]: true }));
      }}
      onDismissNotice={() => setNotice(null)}
      onOpenDoc={(url) => void api.openSiwcDoc(url).catch((e) => setError({ message: describeError(e), cancelled: false }))}
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
