import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isSiwcError, type SiwcStatus } from "../lib/api";
import { describeError } from "../lib/errors";
import { gateView } from "../lib/gate";
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
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SiwcStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<{ message: string; cancelled: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastAttempt = useRef<Attempt>({ clientId: null, promptConsent: false });

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
      if (e.payload.reason === "signed_out") {
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
  if (view.kind === "ready") return <>{children}</>;

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
      onDismissNotice={() => setNotice(null)}
      onOpenDoc={(url) => void api.openSiwcDoc(url).catch((e) => setError({ message: describeError(e), cancelled: false }))}
      onManageUsage={() => void api.openUsage()}
    />
  );
}
