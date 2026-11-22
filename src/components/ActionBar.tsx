import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "./Loader";

/**
 * Top action bar: step title + one-line explanation on the left, status (selection, progress) in the
 * middle, and the actions on the right with the primary action last (top-right), so the main CTA is
 * always visible without scrolling. Used by every step and by the login screen.
 */
export interface TopBarProps {
  eyebrow?: string;
  title: ReactNode;
  desc?: ReactNode;
  /** Status shown next to the actions, e.g. "選択中 12 件・約 48.7 GB". */
  meta?: ReactNode;
  busy?: boolean;
  children?: ReactNode;
}

export function TopBar({ eyebrow, title, desc, meta, busy, children }: TopBarProps) {
  return (
    <div className="topbar" role="region" aria-label="この画面の操作">
      <div className="topbar-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2 className="topbar-title">
          {busy && <Spinner size={18} />}
          <span>{title}</span>
        </h2>
        {desc && <p className="topbar-desc">{desc}</p>}
      </div>
      {meta && <div className="topbar-meta">{meta}</div>}
      {children && <div className="topbar-actions">{children}</div>}
    </div>
  );
}

const SlotContext = createContext<HTMLElement | null>(null);
export const ActionBarSlot = SlotContext.Provider;

/** Renders the step's TopBar into the fixed slot under the stepper (outside the scrolling area). */
export function StepBar(props: TopBarProps) {
  const slot = useContext(SlotContext);
  if (!slot) return null;
  return createPortal(<TopBar {...props} />, slot);
}
