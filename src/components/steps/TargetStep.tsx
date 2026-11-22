import { StepBar } from "../ActionBar";
import { formatBytes } from "../../lib/format";

export type Target = { kind: "mac" } | { kind: "folder"; path: string };

export const MIN_SIZES = [
  { label: "10 MB", bytes: 10e6 },
  { label: "100 MB", bytes: 100e6 },
  { label: "500 MB", bytes: 500e6 },
  { label: "1 GB", bytes: 1e9 },
];

interface Props {
  target: Target;
  onTarget: (t: Target) => void;
  onPickFolder: () => void;
  /** Last folder picked, so switching back to "フォルダを選ぶ" does not reopen the picker. */
  lastFolder: string | null;
  minSize: number;
  onMinSize: (bytes: number) => void;
  onStart: () => void;
  disk: { total: number; available: number } | null;
  canResume: boolean;
  onResume: () => void;
  /** "前回の一覧に戻る", or "前回の AI 判定に戻る" while the list waits for the AI (#12). */
  resumeLabel: string;
}

export function TargetStep(p: Props) {
  const folderPath = p.target.kind === "folder" ? p.target.path : p.lastFolder;
  return (
    <section className="step-page">
      <StepBar
        eyebrow="ステップ 1"
        title="どこをスキャンしますか？"
        desc="大きいファイルやフォルダをサイズ順に一覧します。スキャンはこの Mac の中だけで行い、どこにも送りません。"
      >
        {p.canResume && (
          <button type="button" onClick={p.onResume}>
            {p.resumeLabel}
          </button>
        )}
        <button type="button" className="primary large" onClick={p.onStart}>
          スキャンを開始
        </button>
      </StepBar>

      <div className="choice-grid" role="radiogroup" aria-label="スキャン対象">
        <button
          type="button"
          role="radio"
          aria-checked={p.target.kind === "mac"}
          className={`choice ${p.target.kind === "mac" ? "selected" : ""}`}
          onClick={() => p.onTarget({ kind: "mac" })}
        >
          <span className="choice-icon" aria-hidden="true">💻</span>
          <span className="choice-title">Mac 全体</span>
          <span className="choice-desc">元 CLI（fix-storage）と同じフォルダ群：アプリ、ホーム、キャッシュ、開発ツールなど</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={p.target.kind === "folder"}
          className={`choice ${p.target.kind === "folder" ? "selected" : ""}`}
          onClick={() => (folderPath ? p.onTarget({ kind: "folder", path: folderPath }) : p.onPickFolder())}
        >
          <span className="choice-icon" aria-hidden="true">📁</span>
          <span className="choice-title">フォルダを選ぶ</span>
          <span className="choice-desc">{folderPath ? <code>{folderPath}</code> : "特定のフォルダの中身だけを調べます"}</span>
        </button>
      </div>
      {folderPath && (
        <div className="row end-tight">
          <button type="button" className="link" onClick={p.onPickFolder}>
            別のフォルダを選ぶ…
          </button>
        </div>
      )}

      <div className="field">
        <div className="field-label">表示する最小サイズ</div>
        <div className="segmented" role="radiogroup" aria-label="最小サイズ">
          {MIN_SIZES.map((m) => (
            <button key={m.bytes} type="button" role="radio" aria-checked={p.minSize === m.bytes} className={p.minSize === m.bytes ? "on" : ""} onClick={() => p.onMinSize(m.bytes)}>
              {m.label} 以上
            </button>
          ))}
        </div>
      </div>

      {p.disk && (
        <div className="disk-meter">
          <div className="row space small">
            <span>この Mac の空き容量</span>
            <span>
              <strong>{formatBytes(p.disk.available)}</strong> / {formatBytes(p.disk.total)}
            </span>
          </div>
          <div className="progress">
            <div className="progress-fill used" style={{ width: `${(1 - p.disk.available / Math.max(1, p.disk.total)) * 100}%` }} />
          </div>
        </div>
      )}

    </section>
  );
}
