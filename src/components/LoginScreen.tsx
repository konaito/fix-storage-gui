import type { ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import type { AccountView } from "../lib/api";
import { SIWC_DOCS, type GateView } from "../lib/gate";
import { Spinner } from "./Loader";
import { UpdateCheckButton } from "./UpdateBanner";

interface Props {
  view: Exclude<GateView, { kind: "ready" }>;
  saved: AccountView[];
  signingIn: boolean;
  error: { message: string; cancelled: boolean } | null;
  notice: string | null;
  onSignIn: (clientId: string | null, promptConsent: boolean) => void;
  onCancelSignIn: () => void;
  onReload: () => void;
  onSignOut: () => void;
  onContinueWithoutPlan: (clientId: string) => void;
  onDismissNotice: () => void;
  onOpenDoc: (url: string) => void;
  onManageUsage: () => void;
}

/**
 * First screen: Sign in with ChatGPT is required before anything else is shown.
 * One centred column: what the app does, the one action for the current state, three promises,
 * and the Sign in with ChatGPT details folded underneath.
 */
export function LoginScreen(p: Props) {
  return (
    <div className="login-shell">
      <header className="app-bar">
        <div className="brand">
          <AppIcon />
          <h1>Fix Storage</h1>
        </div>
        <div className="app-bar-tools">
          <UpdateCheckButton />
        </div>
      </header>
      <main className="login-body">
        <div className="login-column">
          {p.notice && (
            <div className="notice" role="status">
              {p.notice} <button className="link" onClick={p.onDismissNotice}>閉じる</button>
            </div>
          )}
          <section className="login-hero" aria-label="サインイン">
            <AppIcon className="login-icon" size={88} />
            <h2 className="login-title">Mac の重いファイルを見つけて、安全にゴミ箱へ。</h2>
            <StatePanel {...p} />
          </section>
          <Promises />
          <Docs onOpenDoc={p.onOpenDoc} onManageUsage={p.onManageUsage} />
        </div>
      </main>
    </div>
  );
}

/** The explanation and the action(s) for the current sign-in state, centred under the title. */
function StatePanel(p: Props) {
  const v = p.view;

  if (v.kind === "checking") {
    return (
      <Lead>
        <span className="login-status">
          <Spinner size={16} /> サインイン状態を確認しています…
        </span>
      </Lead>
    );
  }

  if (v.kind === "load_error") {
    return (
      <>
        <Lead>サインイン状態を確認できませんでした。下の理由を確認して、もう一度お試しください。</Lead>
        <div className="error login-message" role="alert">
          {v.message}
        </div>
        <div className="login-actions">
          <button className="primary large" onClick={p.onReload}>
            もう一度確認する
          </button>
        </div>
      </>
    );
  }

  if (p.signingIn) {
    return (
      <>
        <Lead>
          <span className="login-status">
            <Spinner size={16} /> ブラウザでサインインしてください
          </span>
        </Lead>
        <ol className="login-steps">
          <li>ブラウザで ChatGPT アカウントにサインイン</li>
          <li>許可内容（ChatGPT プランの使用）を確認して許可</li>
          <li>このアプリに戻ると、自動で次の画面に進みます</li>
        </ol>
        <div className="login-actions">
          <button onClick={p.onCancelSignIn}>中止</button>
        </div>
        <p className="login-fine">ブラウザが開かないときは、「中止」を押してやり直してください。</p>
      </>
    );
  }

  if (v.kind === "plan_disabled") {
    return (
      <>
        <Lead>
          <strong>{v.account.label}</strong> でサインイン中です。AI 判定を使うには、ブラウザの許可画面で「ChatGPT プランの使用」を許可してください。
        </Lead>
        {p.error && <ErrorBox error={p.error} />}
        <div className="login-actions">
          <button className="chatgpt-button login-cta" onClick={() => p.onSignIn(v.account.clientId, true)}>
            ChatGPT プランの利用を有効にする
          </button>
          <button onClick={() => p.onContinueWithoutPlan(v.account.clientId)}>AI 判定なしで続ける</button>
        </div>
        <p className="login-fine">
          「AI 判定なしで続ける」を選ぶと、元 CLI のルールとハードブロックだけで判定します。OpenAI には何も送りません。あとからアプリ内でいつでも有効にできます。{" "}
          <button className="link" onClick={p.onSignOut}>
            サインアウト
          </button>
        </p>
      </>
    );
  }

  const reauth = v.reauth;
  const others = p.saved.filter((a) => a.clientId !== reauth?.clientId);
  const choices = reauth ? others : p.saved;
  return (
    <>
      <Lead>AI 判定は、あなたの ChatGPT プランの使用量で動きます。アプリ自体は無料で、API キーも不要です。</Lead>
      {reauth && <p className="warn login-message">前回のサインイン（{reauth.label}）が使えなくなりました。もう一度サインインしてください。</p>}
      {p.error && <ErrorBox error={p.error} />}
      <div className="login-actions">
        <button className="chatgpt-button login-cta" onClick={() => p.onSignIn(reauth ? reauth.clientId : null, false)}>
          Continue with ChatGPT
        </button>
        {choices.length > 0 && (
          <select aria-label="保存済みのアカウント" value="" onChange={(e) => e.target.value && p.onSignIn(e.target.value, false)}>
            <option value="">保存済みのアカウントで続ける…</option>
            {choices.map((a) => (
              <option key={a.clientId} value={a.clientId}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="login-fine">
        ボタンを押すとブラウザが開きます。初回は、ブラウザでこのアプリの登録と許可内容を確認します。
        {reauth && (
          <>
            {" "}
            <button className="link" onClick={() => p.onSignIn(null, false)}>
              別のアカウントでサインイン
            </button>
          </>
        )}
      </p>
    </>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="login-lead">{children}</p>;
}

function ErrorBox({ error }: { error: { message: string; cancelled: boolean } }) {
  return (
    <div className={`${error.cancelled ? "notice" : "error"} login-message`} role="alert">
      {error.message}
      {error.cancelled ? "" : " もう一度お試しください。"}
    </div>
  );
}

/** Three things the app promises, taken from README's safety and privacy sections. */
function Promises() {
  const items: Array<{ title: string; body: string; icon: ReactNode }> = [
    {
      title: "ファイルの中身は送らない",
      body: "AI に送るのはパス・名前・サイズ・日付などのメタデータだけ。送る前に内容を確認できます。",
      icon: <path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z" />,
    },
    {
      title: "完全削除はしない",
      body: "選んだものはゴミ箱へ移すだけ。Finder の「戻す」で元に戻せます。",
      icon: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />,
    },
    {
      title: "トークンはキーチェーンに",
      body: "サインインの情報は macOS のキーチェーンに保存し、画面側には渡しません。",
      icon: <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5zM12 15v2" />,
    },
  ];
  return (
    <ul className="login-promises">
      {items.map((it) => (
        <li key={it.title}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="login-promise-icon">
            {it.icon}
          </svg>
          <strong>{it.title}</strong>
          <span>{it.body}</span>
        </li>
      ))}
    </ul>
  );
}

function Docs({ onOpenDoc, onManageUsage }: { onOpenDoc: (url: string) => void; onManageUsage: () => void }) {
  return (
    <details className="login-docs">
      <summary>Sign in with ChatGPT について</summary>
      <div className="login-docs-body">
        <p>
          OpenAI が提供する、ChatGPT アカウントでアプリにサインインする仕組みです。オプションの「ChatGPT プランの使用量」を許可すると、アプリは対象の AI
          リクエストをあなたの ChatGPT プランで実行できます。この許可で、ChatGPT の会話やその他のアカウント情報にアクセスできるようにはなりません（公式ドキュメントより）。現在はプレビュー版の機能です。
        </p>

        <h3>このアプリでの使い方</h3>
        <ul className="login-points">
          <li>
            <strong>AI 判定だけに使います。</strong>重いファイルやフォルダを「ゴミ箱に移していいか」判定するときに、あなたの ChatGPT プランの使用量を使います。
          </li>
          <li>
            <strong>送るのはメタデータだけです。</strong>パス・名前・拡張子・サイズ・日付・元 CLI の判定などだけを送り、<strong>ファイルの中身は送りません。</strong>
            送る前に、実際に送る内容を画面で確認できます。
          </li>
          <li>
            <strong>トークンは macOS のキーチェーンに保存します。</strong>アプリの画面（Web ビュー）側には渡しません。
          </li>
          <li>
            <strong>サインアウトすると</strong>、ChatGPT 側のセッションを取り消してから、この Mac のトークンを消します。ChatGPT の設定から、いつでもこのアプリの接続を解除できます。
          </li>
          <li>
            使用量は ChatGPT の設定で確認・管理できます。ChatGPT Plus の 5 時間あたりの上限は、ChatGPT プランを使うすべてのアプリで共有されます。{" "}
            <button className="link" onClick={onManageUsage}>
              使用量を管理
            </button>
          </li>
        </ul>

        <h3>公式ドキュメント（ブラウザで開きます）</h3>
        <ul className="login-links">
          {SIWC_DOCS.map((d) => (
            <li key={d.url}>
              <button className="link" onClick={() => onOpenDoc(d.url)} title={d.url}>
                {d.title} ↗
              </button>
              <span className="muted small">{d.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
