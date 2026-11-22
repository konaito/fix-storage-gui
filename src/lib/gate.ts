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
