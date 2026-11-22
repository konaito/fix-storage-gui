import type { AccountView } from "../lib/api";
import { SIWC_DOCS, type GateView } from "../lib/gate";
import { TopBar } from "./ActionBar";
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
 * Same chrome as the app: title + one-line explanation on the left and the main action top-right.
 */
export function LoginScreen(p: Props) {
  return (
    <div className="login-shell">
      <header className="app-bar">
        <div className="brand">
          <div className="app-icon" aria-hidden="true">
            ◐
          </div>
          <h1>Fix Storage</h1>
        </div>
        <div className="app-bar-tools">
          <UpdateCheckButton />
        </div>
      </header>
      <div className="topbar-slot">
        <LoginBar {...p} />
      </div>
      <div className="login-body">
        {p.notice && (
          <div className="notice" role="status">
            {p.notice} <button className="link" onClick={p.onDismissNotice}>閉じる</button>
          </div>
        )}
        <div className="login-grid">
          <section className="card login-card" aria-label="サインイン">
            <SignInDetails {...p} />
          </section>
          <Docs onOpenDoc={p.onOpenDoc} onManageUsage={p.onManageUsage} />
        </div>
      </div>
    </div>
  );
}

function LoginBar(p: Props) {
  const v = p.view;
  if (v.kind === "checking") {
    return <TopBar busy title="サインイン状態を確認しています…" desc="キーチェーンに保存されたサインイン情報を読み込んでいます。" />;
  }
  if (v.kind === "load_error") {
    return (
      <TopBar title="サインイン状態を確認できませんでした" desc="下の理由を確認して、もう一度お試しください。">
        <button className="primary large" onClick={p.onReload}>
          もう一度確認する
        </button>
      </TopBar>
    );
  }
  if (p.signingIn) {
    return (
      <TopBar busy title="ブラウザでサインインしてください" desc="ChatGPT のサインイン画面をブラウザで開きました。許可を終えたら、このアプリに戻ってきてください。">
        <button onClick={p.onCancelSignIn}>中止</button>
      </TopBar>
    );
  }
  if (v.kind === "plan_disabled") {
    return (
      <TopBar
        title="ChatGPT プランの利用が許可されていません"
        desc={
          <>
            <strong>{v.account.label}</strong> でサインイン中です。AI 判定を使うには、ChatGPT プランの使用を許可してください。
          </>
        }
      >
        <button onClick={() => p.onContinueWithoutPlan(v.account.clientId)}>AI 判定なしで続ける</button>
        <button className="chatgpt-button large" onClick={() => p.onSignIn(v.account.clientId, true)}>
          ChatGPT プランの利用を有効にする
        </button>
      </TopBar>
    );
  }
  const reauth = v.reauth;
  const others = p.saved.filter((a) => a.clientId !== reauth?.clientId);
  const choices = reauth ? others : p.saved;
  return (
    <TopBar title="ChatGPT でサインイン" desc="AI 判定は、あなたの ChatGPT プランの使用量で動きます。アプリ自体は無料で、API キーも不要です。">
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
      <button className="chatgpt-button large" onClick={() => p.onSignIn(reauth ? reauth.clientId : null, false)}>
        Continue with ChatGPT
      </button>
    </TopBar>
  );
}

/** Explanations for the current state. The actions themselves are only in the top bar. */
function SignInDetails(p: Props) {
  const v = p.view;

  if (v.kind === "checking") {
    return <p className="muted">しばらくお待ちください。</p>;
  }

  if (v.kind === "load_error") {
    return (
      <div className="error" role="alert">
        {v.message}
      </div>
    );
  }

  if (p.signingIn) {
    return (
      <>
        <h3>サインインの流れ</h3>
        <ol className="login-steps small">
          <li>ブラウザで ChatGPT アカウントにサインイン</li>
          <li>許可内容（ChatGPT プランの使用）を確認して許可</li>
          <li>このアプリに戻ると、自動で次の画面に進みます</li>
        </ol>
        <p className="muted small">ブラウザが開かないときは、右上の「中止」を押してやり直してください。</p>
      </>
    );
  }

  if (v.kind === "plan_disabled") {
    return (
      <>
        {p.error && <ErrorBox error={p.error} />}
        <p>ブラウザの許可画面で「ChatGPT プランの使用」を許可すると、AI 判定が使えるようになります。</p>
        <p className="muted small">
          「AI 判定なしで続ける」を選ぶと、元 CLI のルールとハードブロックだけで判定します。OpenAI には何も送りません。あとからアプリ内でいつでも有効にできます。
        </p>
        <button className="link" onClick={p.onSignOut}>
          サインアウト
        </button>
      </>
    );
  }

  const reauth = v.reauth;
  return (
    <>
      {reauth && <p className="warn">前回のサインイン（{reauth.label}）が使えなくなりました。もう一度サインインしてください。</p>}
      {p.error && <ErrorBox error={p.error} />}
      <p>
        このアプリの AI 判定は、あなたの ChatGPT プラン（またはクレジット残高）に含まれる使用量で動きます。右上の「Continue with ChatGPT」からサインインしてください。
      </p>
      <p className="muted small">ボタンを押すとブラウザが開きます。初回は、ブラウザでこのアプリの登録と許可内容を確認します。</p>
      {reauth && (
        <button className="link" onClick={() => p.onSignIn(null, false)}>
          別のアカウントでサインイン
        </button>
      )}
    </>
  );
}

/** The retry is the top bar's main action, so the error box only explains. */
function ErrorBox({ error }: { error: { message: string; cancelled: boolean } }) {
  return (
    <div className={error.cancelled ? "notice" : "error"} role="alert">
      <span>
        {error.message}
        {error.cancelled ? "" : " 右上のボタンからもう一度お試しください。"}
      </span>
    </div>
  );
}

function Docs({ onOpenDoc, onManageUsage }: { onOpenDoc: (url: string) => void; onManageUsage: () => void }) {
  return (
    <section className="card login-docs" aria-labelledby="docs-title">
      <h2 id="docs-title">Sign in with ChatGPT について</h2>
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
    </section>
  );
}
