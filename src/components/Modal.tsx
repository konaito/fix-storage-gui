import { createFocusTrap } from "focus-trap";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Focus moves to the first control when the dialog opens, Tab stays inside it, and focus goes back to where it
 * was when it closes (#78). Esc does nothing, as before; the backdrop still closes it when `onClose` is given.
 */
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const trap = createFocusTrap(el, {
      fallbackFocus: el,
      escapeDeactivates: false,
      allowOutsideClick: true,
      // The opener may be gone by now (e.g. the step page was re-created); then leave focus to the step change.
      setReturnFocus: (prev) => (prev instanceof HTMLElement && prev.isConnected ? prev : false),
    });
    trap.activate();
    return () => {
      trap.deactivate();
    };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={dialog} className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
