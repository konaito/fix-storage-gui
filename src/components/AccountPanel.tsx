import type { AccountView, Model, SiwcStatus } from "../lib/api";

interface Props {
  status: SiwcStatus | null;
  models: Model[];
  model: string;
  onModel: (slug: string) => void;
  signingIn: boolean;
  onSignIn: (clientId: string | null, promptConsent: boolean) => void;
  onCancelSignIn: () => void;
  onSwitch: (clientId: string) => void;
  onSignOut: () => void;
  onManageUsage: () => void;
  onReloadModels: () => void;
}

/** Sign in with ChatGPT controls, following the official UI/UX guidelines' wording. */
export function AccountPanel(p: Props) {
  const active: AccountView | undefined = p.status?.accounts.find((a) => a.clientId === p.status?.active);
  const saved = p.status?.accounts ?? [];

  if (p.signingIn) {
    return (
      <div className="card account">
        <p>ブラウザで ChatGPT にサインインしてください…</p>
        <button onClick={p.onCancelSignIn}>中止</button>
      </div>
    );
  }

  if (!active || !active.signedIn) {
    return (
      <div className="card account">
        <h3>ChatGPT プランを使う</h3>
        <p className="muted">
          AI 判定は、あなたの ChatGPT プラン（または残っているクレジット）の使用量で動きます。このアプリ自体に料金はありません。API キーは不要です。
        </p>
        {active?.needsReauth && <p className="warn">前回のサインインが使えなくなりました。もう一度サインインしてください。</p>}
        <div className="row">
          {saved.length > 0 && (
            <select
              aria-label="保存済みのアカウント"
              defaultValue=""
              onChange={(e) => e.target.value && p.onSignIn(e.target.value, false)}
            >
              <option value="">保存済みのアカウントで続ける…</option>
              {saved.map((a) => (
                <option key={a.clientId} value={a.clientId}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
          <button className="chatgpt-button" onClick={() => p.onSignIn(null, false)}>
            Continue with ChatGPT
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card account">
      <div className="row space">
        <div>
          <div className="muted small">サインイン中</div>
          <strong>{active.label}</strong>
        </div>
        <div className="row">
          {saved.length > 1 && (
            <select aria-label="アカウントを切り替え" value={active.clientId} onChange={(e) => p.onSwitch(e.target.value)}>
              {saved.map((a) => (
                <option key={a.clientId} value={a.clientId}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => p.onSignIn(null, false)}>別のアカウントを追加</button>
          <button onClick={p.onSignOut}>サインアウト</button>
        </div>
      </div>
      {active.planEnabled ? (
        <div className="row model-row">
          <label>
            モデル{" "}
            <select value={p.model} onChange={(e) => p.onModel(e.target.value)} disabled={p.models.length === 0}>
              {p.models.length === 0 && <option value="">（モデル一覧を取得できていません）</option>}
              {p.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <button className="link" onClick={p.onReloadModels}>
            再読み込み
          </button>
          <span className="plan-badge">ChatGPT プランを使用中</span>
          <button className="link" onClick={p.onManageUsage}>
            使用量を管理
          </button>
        </div>
      ) : (
        <div className="warn-box">
          <p>このアカウントでは ChatGPT プランの利用が許可されていないため、AI 判定は使えません（元 CLI のルール判定は使えます）。</p>
          <button className="chatgpt-button" onClick={() => p.onSignIn(active.clientId, true)}>
            ChatGPT プランの利用を有効にする
          </button>
        </div>
      )}
    </div>
  );
}
