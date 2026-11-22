import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** Signed-in account label (e.g. the e-mail address); null before the status is loaded. */
  label: string | null;
  /** While the browser sign-in is open the panel shows "中止", so it stays open until that ends. */
  signingIn: boolean;
  /** Reason the account can't be changed right now (e.g. "ゴミ箱へ移動中"); the button is disabled. */
  locked: string | null;
  children: ReactNode;
}

/**
 * App-bar button that opens the account / model panel (#13 proposal). Only the initial is shown so the
 * stepper stays near the middle of the bar; the full label is in the tooltip and the panel. The panel used to sit in a
 * right sidebar on steps 1-3. Built with React state instead of the HTML `popover` attribute
 * because the app supports macOS 12, whose WebKit predates it.
 */
export function AccountMenu(p: Props) {
  const [open, setOpen] = useState(false);
  const shown = !p.locked && (open || p.signingIn);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shown || p.signingIn) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown, p.signingIn]);

  const name = p.label ?? "アカウント";
  return (
    <div className="account-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="update-chip account-chip"
        aria-expanded={shown}
        aria-controls="account-popover"
        aria-label={`アカウントとモデル（${name}）`}
        title={p.locked ? `${p.locked}はアカウントを変更できません` : name}
        disabled={!!p.locked}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="account-initial" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      </button>
      {shown && (
        <div id="account-popover" className="account-popover" role="dialog" aria-label="アカウントとモデル">
          {p.children}
        </div>
      )}
    </div>
  );
}
