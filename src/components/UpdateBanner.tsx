import { useEffect, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "../lib/format";
import {
  checkForUpdate,
  clearUpdateMessage,
  dismissUpdate,
  downloadFraction,
  installUpdate,
  revealUpdate,
  useUpdateState,
} from "../lib/updater";
import { ProgressBar, Spinner } from "./Loader";

/** 起動時の自動確認は 1 回だけ（StrictMode の二重マウントでも 1 回）。 */
let autoChecked = false;
/** 起動直後の描画やサインイン状態の確認を邪魔しないよう、少し待ってから確認する。 */
const AUTO_CHECK_DELAY_MS = 3000;

/**
 * アプリ内アップデートの通知カード（画面右下）。ログイン画面でもアプリ本体でも出る。
 * - 起動時に静かに確認し、新しいバージョンがあればヘッダーのボタンで知らせる（押すとバージョンとリリースノートのカード）。
 * - アプリメニューの「アップデートを確認…」（Rust 側から `check-for-updates` イベント）でも確認する。
 * - スキャン・AI 判定・ゴミ箱移動の最中は自動で見つけた通知を出さず、インストールも始めない。
 */
export function UpdateBanner() {
  const s = useUpdateState();

  useEffect(() => {
    if (!autoChecked) {
      autoChecked = true;
      // StrictMode の二重マウントでも消さない（確認は起動ごとに 1 回だけ）ので、クリーンアップでは止めない。
      setTimeout(() => void checkForUpdate(false), AUTO_CHECK_DELAY_MS);
    }
    const un = "__TAURI_INTERNALS__" in window ? listen("check-for-updates", () => void checkForUpdate(true)) : null;
    return () => {
      void un?.then((f) => f());
    };
  }, []);

  const p = s.phase;
  const busyNote = s.blockedBy ? `${s.blockedBy}のため、終わるまでアップデートは始められません。` : null;

  switch (p.kind) {
    case "idle":
      return null;

    case "checking":
      if (!p.manual) return null;
      return (
        <Card>
          <div className="update-row">
            <Spinner size={16} label="アップデートを確認中" />
            <span>アップデートを確認しています…</span>
          </div>
        </Card>
      );

    case "upToDate":
      return (
        <Card>
          <div className="update-row">
            <span className="update-ok" aria-hidden="true">
              ✓
            </span>
            <span>お使いのバージョンが最新です。</span>
          </div>
          <div className="update-actions">
            <button type="button" onClick={clearUpdateMessage}>
              閉じる
            </button>
          </div>
        </Card>
      );

    case "available": {
      // 自動で見つけたときはヘッダーのボタン（「vX にアップデート」）だけを目立たせ、カードは出さない。
      // 画面上部のメイン操作や右下の詳細パネルを覆わないよう、ユーザーが押したときだけカードを開く。
      if (!s.revealed) return null;
      return (
        <Card>
          <div className="update-title">
            新しいバージョン <strong>v{p.info.version}</strong> があります
          </div>
          <div className="muted small">
            現在のバージョン: v{p.info.currentVersion}
            {p.info.date && <> ・ 公開日: {p.info.date.slice(0, 10)}</>}
          </div>
          {p.info.notes && (
            <div className="update-notes" tabIndex={0} aria-label="リリースノート">
              {p.info.notes}
            </div>
          )}
          {busyNote && <p className="update-busy small">{busyNote}</p>}
          <div className="update-actions">
            <button type="button" onClick={dismissUpdate}>
              あとで
            </button>
            <button type="button" className="primary" disabled={!!s.blockedBy} onClick={() => void installUpdate()}>
              アップデートして再起動
            </button>
          </div>
        </Card>
      );
    }

    case "downloading": {
      const frac = downloadFraction(p.downloaded, p.total);
      return (
        <Card>
          <div className="update-title">v{p.info.version} をダウンロードしています…</div>
          <ProgressBar value={frac} label="アップデートのダウンロード" />
          <div className="muted small update-bytes">
            {p.total
              ? `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}（${Math.round((frac ?? 0) * 100)}%）`
              : p.downloaded > 0
                ? `${formatBytes(p.downloaded)} ダウンロード済み`
                : "接続しています…"}
          </div>
        </Card>
      );
    }

    case "installing":
      return (
        <Card>
          <div className="update-title">v{p.info.version} をインストールしています…</div>
          <ProgressBar value={null} label="アップデートのインストール" />
          <div className="muted small">署名を確認してアプリを置き換えています。終わると自動で再起動します。</div>
        </Card>
      );

    case "restarting":
      return (
        <Card>
          <div className="update-row">
            <Spinner size={16} label="再起動中" />
            <span>v{p.info.version} で再起動しています…</span>
          </div>
        </Card>
      );

    case "error":
      return (
        <Card tone="error">
          <div className="update-title">{p.during === "check" ? "アップデートを確認できませんでした" : "アップデートできませんでした"}</div>
          <p className="small update-error-msg">{p.message}</p>
          {p.during === "install" && busyNote && <p className="update-busy small">{busyNote}</p>}
          <div className="update-actions">
            <button type="button" onClick={p.during === "check" ? clearUpdateMessage : dismissUpdate}>
              {p.during === "check" ? "閉じる" : "あとで"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={p.during === "install" && !!s.blockedBy}
              onClick={() => void (p.during === "check" ? checkForUpdate(true) : installUpdate())}
            >
              再試行
            </button>
          </div>
        </Card>
      );
  }
}

function Card({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <section className={`update-banner ${tone === "error" ? "is-error" : ""}`} role="status" aria-live="polite" aria-label="アップデート">
      {children}
    </section>
  );
}

/** ヘッダーなどに置く小さなボタン。通常は「アップデートを確認」、見つかっていれば新バージョンを表示する。 */
export function UpdateCheckButton() {
  const s = useUpdateState();
  const p = s.phase;
  if (p.kind === "available") {
    return (
      <button type="button" className="update-chip has-update" onClick={revealUpdate} title="アップデートの内容を見る" aria-haspopup="dialog">
        <span className="update-dot" aria-hidden="true" />v{p.info.version} にアップデート
      </button>
    );
  }
  const busy = p.kind === "checking" || p.kind === "downloading" || p.kind === "installing" || p.kind === "restarting";
  return (
    <button type="button" className="update-chip" disabled={busy} onClick={() => void checkForUpdate(true)}>
      {p.kind === "checking" ? "確認中…" : "アップデートを確認"}
    </button>
  );
}
