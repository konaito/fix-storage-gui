import type { ReactNode } from "react";

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? "読み込み中"} />;
}

/** Determinate when `value` is a number (0..1), otherwise an honest indeterminate bar. */
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  const det = value != null;
  return (
    <div
      className={`progress ${det ? "" : "indeterminate"}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={det ? 0 : undefined}
      aria-valuemax={det ? 100 : undefined}
      aria-valuenow={det ? Math.round(value * 100) : undefined}
    >
      <div className="progress-fill" style={det ? { width: `${value * 100}%` } : undefined} />
    </div>
  );
}

/** Large centred loading panel used for every async phase. */
export function LoadingPanel({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="loading-panel" aria-live="polite">
      <div className="loading-head">
        <Spinner size={28} />
        <h2>{title}</h2>
      </div>
      {children}
      {footer && <div className="loading-foot">{footer}</div>}
    </div>
  );
}

/** Current path line that never wraps the layout. */
export function CurrentPath({ path }: { path: string }) {
  if (!path) return null;
  return (
    <div className="current-path" title={path}>
      <span>{path}</span>
    </div>
  );
}
