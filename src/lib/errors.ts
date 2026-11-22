import { isSiwcError } from "./api";

/** Japanese message for an error from the Rust side, keeping code / status / request ID for diagnosis. */
export function describeError(e: unknown): string {
  if (!isSiwcError(e)) return e instanceof Error ? e.message : String(e);
  const base: Record<string, string> = {
    consent_declined: "ChatGPT プランの利用が許可されませんでした。あとから設定で有効にできます。",
    plan_not_enabled: "このアカウントでは ChatGPT プランの利用が許可されていません。「ChatGPT プランの利用を有効にする」から許可してください。",
    usage_limit: "使用量の上限に達しました。ChatGPT の設定で、プランかこのアプリの上限を確認してください。",
    not_eligible: "このアカウント・ワークスペース・ポリシーでは ChatGPT プランを使えません。",
    usage_unavailable: "使用量を確認できませんでした。少し待ってからもう一度試してください。",
    user_unavailable: "アカウント情報を一時的に取得できません。少し待ってから試してください。",
    unsupported_capability: "このリクエストの内容はプレビュー中の ChatGPT プラン利用では使えません。",
    route_not_supported: "この API の使い方はサポートされていません。",
    invalid_user: "アカウントを確認できませんでした。もう一度サインインしてください。",
    not_authorized: "許可された範囲ではこの操作はできません。",
    reauth_required: "サインインの有効期限が切れたか、ChatGPT 側で接続が解除されました。もう一度サインインしてください。",
    signed_out: "ChatGPT にサインインしていません。",
    client_revoked: "このアプリの登録が ChatGPT 側で使えなくなりました。もう一度サインインすると、新しく登録し直します。",
    account_changed: "AI 判定の途中でアカウントが切り替わったため、残りは送りませんでした。",
    unauthorized: "認証が受け付けられませんでした。選択中のアカウントと許可内容を確認してください。",
    forbidden: "ポリシーや地域などの制限で利用できませんでした。",
    unavailable: "現在利用できません。少し待ってからもう一度試してください。",
    rate_limited: "リクエストが多すぎます。少し待ってから試してください。",
    interrupted: "通信が途中で切れました。もう一度試してください。",
    incomplete: "AI の応答が途中で終わりました。項目を減らして試してください。",
    network: "ネットワークに接続できません。",
    timeout: "サインインが時間内に完了しませんでした。",
    cancelled: "サインインを中止しました。",
    ai_timeout: "AI の応答が時間内に終わりませんでした。",
    ai_cancelled: "AI 判定を中止しました。",
  };
  const parts = [base[e.kind] ?? e.message];
  if (base[e.kind] && e.message) parts.push(`（${e.message}）`);
  const diag = [e.status ? `HTTP ${e.status}` : null, e.code, e.param ? `param=${e.param}` : null, e.requestId ? `request ID: ${e.requestId}` : null]
    .filter(Boolean)
    .join(" / ");
  if (diag) parts.push(`[${diag}]`);
  return parts.join(" ");
}

/** Message for the error band when "Finder で表示" fails (#63). The Rust side returns only the reason. */
export function revealFailedJa(e: unknown): string {
  return `Finder で表示できませんでした: ${describeError(e)}`;
}
