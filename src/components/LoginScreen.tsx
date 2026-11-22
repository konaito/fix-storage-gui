import type { AccountView } from "../lib/api";
import { SIWC_DOCS, type GateView } from "../lib/gate";

interface Props {
  view: Exclude<GateView, { kind: "ready" }>;
  saved: AccountView[];
  signingIn: boolean;
  error: { message: string; cancelled: boolean } | null;
  notice: string | null;
  onSignIn: (clientId: string | null, promptConsent: boolean) => void;
  onRetry: () => void;
  onCancelSignIn: () => void;
  onReload: () => void;
  onSignOut: () => void;
  onDismissNotice: () => void;
  onOpenDoc: (url: string) => void;
  onManageUsage: () => void;
}

/** First screen: Sign in with ChatGPT is required before anything else is shown. */
export function LoginScreen(p: Props) {
  if (p.view.kind === "checking") {
    return (
      <div className="login-wrap">
        <div className="card login-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>サインイン状態を確認しています…</strong>
            <div className="muted small">キーチェーンに保存されたサインイン情報を読み込んでいます。</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <header className="login-header">
        <h1>Fix Storage GUI</h1>
        <div className="muted small">fix-storage のコアを使ったストレージ整理 ・ Sign in with ChatGPT のデモアプリ</div>
      </header>

      {p.notice && (
        <div className="notice" role="status">
          {p.notice} <button className="link" onClick={p.onDismissNotice}>閉じる</button>
        </div>
      )}

      <div className="login-grid">
        <section className="card login-card" aria-labelledby="login-title">
          <SignInPanel {...p} />
        </section>
        <Docs onOpenDoc={p.onOpenDoc} onManageUsage={p.onManageUsage} />
      </div>
    </div>
  );
}

function SignInPanel(p: Props) {
  const v = p.view;

  if (v.kind === "load_error") {
    return (
      <>
        <h2 id="login-title">サインイン状態を確認できませんでした</h2>
        <div className="error" role="alert">{v.message}</div>
        <button className="primary" onClick={p.onReload}>
          もう一度確認する
        </button>
      </>
    );
  }

  if (p.signingIn) {
    return (
      <>
        <h2 id="login-title">ブラウザでサインインしてください</h2>
        <div className="login-loading inline" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>ChatGPT のサインイン画面をブラウザで開きました</strong>
            <div className="muted small">サインインと許可を終えたら、このアプリに戻ってきてください。ブラウザが開かないときは中止してやり直してください。</div>
          </div>
        </div>
        <ol className="login-steps small">
          <li>ブラウザで ChatGPT アカウントにサインイン</li>
          <li>許可内容（ChatGPT プランの使用）を確認して許可</li>
          <li>このアプリに戻ると、自動で次の画面に進みます</li>
        </ol>
        <button onClick={p.onCancelSignIn}>中止</button>
      </>
    );
  }

  if (v.kind === "plan_disabled") {
    return (
      <>
        <h2 id="login-title">ChatGPT プランの利用が許可されていません</h2>
        <p>
          <strong>{v.account.label}</strong> でサインインしていますが、ChatGPT プランの使用が許可されていないため、このアプリは使えません。
          ブラウザの許可画面で「ChatGPT プランの使用」を許可してください。
        </p>
        {p.error && <ErrorBox {...p} />}
        <div className="row">
          <button className="chatgpt-button" onClick={() => p.onSignIn(v.account.clientId, true)}>
            ChatGPT プランの利用を有効にする
          </button>
          <button onClick={p.onSignOut}>サインアウト</button>
        </div>
      </>
    );
  }

  // signed_out
  const reauth = v.kind === "signed_out" ? v.reauth : null;
  const others = p.saved.filter((a) => a.clientId !== reauth?.clientId);
  return (
    <>
      <h2 id="login-title">ChatGPT プランを使う</h2>
      <p>
        このアプリの AI 判定は、あなたの ChatGPT プラン（またはクレジット残高）に含まれる使用量で動きます。まず ChatGPT でサインインしてください。
      </p>
      <p className="muted small">このアプリ自体に料金はかかりません。API キーも不要です。</p>

      {reauth && (
        <p className="warn">
          前回のサインイン（{reauth.label}）が使えなくなりました。もう一度サインインしてください。
        </p>
      )}
      {p.error && <ErrorBox {...p} />}

      <div className="login-actions">
        {reauth ? (
          <button className="chatgpt-button" onClick={() => p.onSignIn(reauth.clientId, false)}>
            Continue with ChatGPT
          </button>
        ) : (
          <button className="chatgpt-button" onClick={() => p.onSignIn(null, false)}>
            Continue with ChatGPT
          </button>
        )}
        {(reauth ? others.length > 0 : p.saved.length > 0) && (
          <select aria-label="保存済みのアカウント" value="" onChange={(e) => e.target.value && p.onSignIn(e.target.value, false)}>
            <option value="">保存済みのアカウントで続ける…</option>
            {(reauth ? others : p.saved).map((a) => (
              <option key={a.clientId} value={a.clientId}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        {reauth && (
          <button className="link" onClick={() => p.onSignIn(null, false)}>
            別のアカウントでサインイン
          </button>
        )}
      </div>
      <p className="muted small">ボタンを押すとブラウザが開きます。初回は、ブラウザでこのアプリの登録と許可内容を確認します。</p>
    </>
  );
}

function ErrorBox(p: Props) {
  if (!p.error) return null;
  return (
    <div className={p.error.cancelled ? "notice" : "error"} role="alert">
      {p.error.message}
      <div className="row">
        <button className="primary" onClick={p.onRetry}>
          もう一度試す
        </button>
      </div>
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
