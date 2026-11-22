import type { AccountView, SiwcStatus } from "./api";

/** Official Sign in with ChatGPT docs linked from the login screen (each URL checked to exist). */
export const SIWC_DOCS: Array<{ url: string; title: string; note: string }> = [
  { url: "https://developers.openai.com/siwc", title: "Sign in with ChatGPT", note: "公式ドキュメントのトップ" },
  {
    url: "https://developers.openai.com/siwc/token-sharing-open-source",
    title: "ChatGPT プランの使用量（概要）",
    note: "オープンソース／ローカルアプリ向けの仕組み",
  },
  { url: "https://developers.openai.com/siwc/token-sharing-open-source/sign-in", title: "登録とサインイン", note: "ブラウザでのサインインと許可の流れ" },
  {
    url: "https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions",
    title: "アカウントとセッション",
    note: "サインアウト・トークンの保護・使用量",
  },
  { url: "https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations", title: "プレビューの制限", note: "現在の制限事項" },
  { url: "https://developers.openai.com/siwc/ui-ux-guidelines", title: "UI/UX ガイドライン", note: "この画面の文言の元になったガイドライン" },
];

export type GateView =
  | { kind: "checking" }
  | { kind: "load_error"; message: string }
  | { kind: "signed_out"; reauth: AccountView | null }
  | { kind: "plan_disabled"; account: AccountView }
  | { kind: "ready"; account: AccountView };

/** The app is usable only with an active, signed-in account that allowed ChatGPT plan usage. */
export function gateView(status: SiwcStatus | null, loadError: string | null): GateView {
  if (loadError) return { kind: "load_error", message: loadError };
  if (!status) return { kind: "checking" };
  const active = status.accounts.find((a) => a.clientId === status.active);
  if (!active || !active.signedIn) return { kind: "signed_out", reauth: active?.needsReauth ? active : null };
  if (!active.planEnabled) return { kind: "plan_disabled", account: active };
  return { kind: "ready", account: active };
}

/**
 * Registration that the login screen's main button reauthorises: the one that needs reauth,
 * else the only saved one (after a sign-out the registration is kept, only its tokens are gone).
 * `null` registers a new client.
 */
export function primarySignInTarget(reauth: AccountView | null, saved: AccountView[]): AccountView | null {
  return reauth ?? (saved.length === 1 ? saved[0] : null);
}

/** Why the Rust side says the stored sign-in may have changed (`siwc-changed`). */
export type SiwcChangeReason = "signed_in" | "signed_out" | "switched" | "reauth" | "client_revoked";

export interface SiwcChanged {
  reason: SiwcChangeReason;
  remoteRevoked: boolean | null;
}

export interface GateError {
  message: string;
  cancelled: boolean;
}

/**
 * Sign-in state the whole app reads (#29, #30). It lives only in the login gate; the app gets it
 * through `GateContext`, so the gate and the app can't disagree about the account or run two sign-ins.
 */
export interface GateModel {
  status: SiwcStatus | null;
  loadError: string | null;
  signingIn: boolean;
  /** Error from a sign-in / sign-out started on the login screen or the rule-only bar. */
  error: GateError | null;
  notice: string | null;
  /** Increments on every `siwc-changed` event. */
  statusVersion: number;
  /** The wrapped app has a scan result (or a scan / AI run / trash move running) that the login screen would throw away (#75). */
  appHasResults: boolean;
  /** What the app is running ("AI 判定中" …), or null. Signing in again waits for it (#28). */
  appBusy: string | null;
  /**
   * A token stopped working while the app held results: keep the app mounted with a bar to sign in again
   * instead of the login screen (#75). Cleared by a sign-out, by the app dropping its results, or once ready again.
   */
  keepApp: "reauth" | "client_revoked" | null;
}

export const initialGate: GateModel = {
  status: null,
  loadError: null,
  signingIn: false,
  error: null,
  notice: null,
  statusVersion: 0,
  appHasResults: false,
  appBusy: null,
  keepApp: null,
};

export type GateAction =
  | { type: "loaded"; status: SiwcStatus }
  | { type: "loadFailed"; message: string }
  | { type: "reload" }
  | { type: "signInStart" }
  | { type: "signInEnd" }
  | { type: "error"; error: GateError | null }
  | { type: "changed"; event: SiwcChanged }
  | { type: "dismissNotice" }
  | { type: "app"; hasResults: boolean; busy: string | null }
  /** The app's own request failed with reauth_required / client_revoked; sent before it reads status again. */
  | { type: "lost"; reason: "reauth" | "client_revoked" };

export const SIGNED_OUT_NOTICE = "サインアウトしました。";
export const SIGNED_OUT_UNREVOKED_NOTICE =
  "サインアウトしました。この Mac のトークンは消しましたが、ChatGPT 側での接続解除を確認できませんでした。必要なら ChatGPT の設定からこのアプリの接続を解除してください。";
export const REAUTH_NOTICE = "使用中に ChatGPT へのサインインが使えなくなったため、ログイン画面に戻りました。";
export const CLIENT_REVOKED_NOTICE =
  "このアプリの登録が ChatGPT 側で使えなくなったため、登録を消してログイン画面に戻りました。もう一度サインインすると新しく登録します。ほかの保存済みアカウントが選ばれているときは「別のアカウントでサインイン」から登録してください。";

function lostSignInNotice(reason: "reauth" | "client_revoked"): string {
  return reason === "reauth" ? REAUTH_NOTICE : CLIENT_REVOKED_NOTICE;
}

/** A token stopped working during use. */
function signInLost(s: GateModel, reason: "reauth" | "client_revoked"): GateModel {
  // The app holds a scan result: keep it on screen with a bar to sign in again (#75).
  if (s.appHasResults) return { ...s, keepApp: s.keepApp ?? reason };
  // Otherwise say why the login screen is back, without replacing a notice that is already there (e.g. "signed out").
  return { ...s, notice: s.notice ?? lostSignInNotice(reason) };
}

export function gateReducer(s: GateModel, a: GateAction): GateModel {
  switch (a.type) {
    case "loaded":
      // Signed in again: the bar has done its job.
      return { ...s, status: a.status, loadError: null, keepApp: gateView(a.status, null).kind === "ready" ? null : s.keepApp };
    case "loadFailed":
      return { ...s, loadError: a.message };
    case "reload":
      return { ...s, status: null, loadError: null };
    case "signInStart":
      return { ...s, signingIn: true, error: null, notice: null };
    case "signInEnd":
      return { ...s, signingIn: false };
    case "error":
      return { ...s, error: a.error };
    case "dismissNotice":
      return { ...s, notice: null };
    case "app":
      // The app dropped its results (e.g. "最初からやり直す") while the bar was up: the login screen comes back, so say why.
      if (!a.hasResults && s.keepApp) return { ...s, appHasResults: false, appBusy: a.busy, keepApp: null, notice: s.notice ?? lostSignInNotice(s.keepApp) };
      return { ...s, appHasResults: a.hasResults, appBusy: a.busy };
    case "changed": {
      const next = { ...s, statusVersion: s.statusVersion + 1 };
      if (a.event.reason === "signed_out") {
        return { ...next, error: null, keepApp: null, notice: a.event.remoteRevoked === false ? SIGNED_OUT_UNREVOKED_NOTICE : SIGNED_OUT_NOTICE };
      }
      if (a.event.reason === "reauth" || a.event.reason === "client_revoked") return signInLost(next, a.event.reason);
      return next;
    }
    case "lost":
      // Same as the siwc-changed event, which may arrive after the app's own status read (#75).
      return signInLost(s, a.reason);
  }
}

export type GateBar =
  | { kind: "rule_only"; account: AccountView }
  /** Signed out by a token that stopped working; `target` is the registration the sign-in button reauthorises (`null` registers anew). */
  | { kind: "reauth"; reason: "reauth" | "client_revoked"; account: AccountView | null; target: string | null };

/** What the login gate renders: the wrapped app (with an optional bar above it) or the login screen. */
export type GateScreen = { kind: "app"; account: AccountView | null; planEnabled: boolean; bar: GateBar | null } | { kind: "login"; view: Exclude<GateView, { kind: "ready" }> };

/** `continuesWithoutPlan(clientId)`: the user chose rule-only mode for that registration. */
export function gateScreen(g: GateModel, continuesWithoutPlan: (clientId: string) => boolean): GateScreen {
  // While the bar is up, a failed status read keeps the last known status instead of unmounting the app (#75).
  const view = gateView(g.status, g.keepApp && g.status ? null : g.loadError);
  if (view.kind === "ready") return { kind: "app", account: view.account, planEnabled: true, bar: null };
  if (view.kind === "plan_disabled" && (g.keepApp || continuesWithoutPlan(view.account.clientId))) {
    return { kind: "app", account: view.account, planEnabled: false, bar: { kind: "rule_only", account: view.account } };
  }
  if (view.kind === "signed_out" && g.keepApp) {
    // reauth: reauthorise that registration. client_revoked: it is gone, so register anew rather than
    // pointing at whatever other registration is saved (#69's account_mismatch).
    const target = view.reauth?.clientId ?? (g.keepApp === "reauth" ? (primarySignInTarget(null, g.status?.accounts ?? [])?.clientId ?? null) : null);
    return { kind: "app", account: null, planEnabled: false, bar: { kind: "reauth", reason: g.keepApp, account: view.reauth, target } };
  }
  return { kind: "login", view };
}

/**
 * Runs `fn` only when no earlier call is still running; a call made meanwhile resolves to
 * `{ started: false }` without calling `fn`. The gate wraps sign-in with it, so a second click
 * (on the login screen, the rule-only bar or the account panel) can't start a second sign-in (#30).
 */
export function singleFlight<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  let running = false;
  return async (...args: A): Promise<{ started: false } | { started: true; value: R }> => {
    if (running) return { started: false };
    running = true;
    try {
      return { started: true, value: await fn(...args) };
    } finally {
      running = false;
    }
  };
}

const RULE_ONLY_KEY = "fsg.ruleOnly.";

/** Remembers (per account registration) that the user chose to continue without ChatGPT plan usage. */
export const ruleOnlyChoice = {
  get(clientId: string): boolean {
    try {
      return localStorage.getItem(RULE_ONLY_KEY + clientId) === "1";
    } catch {
      return false;
    }
  },
  clearAll() {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(RULE_ONLY_KEY)) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
  set(clientId: string, on: boolean) {
    try {
      if (on) localStorage.setItem(RULE_ONLY_KEY + clientId, "1");
      else localStorage.removeItem(RULE_ONLY_KEY + clientId);
    } catch {
      /* storage unavailable: the choice lasts for this session only */
    }
  },
};
