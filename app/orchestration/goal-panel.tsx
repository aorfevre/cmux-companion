"use client";
import { useEffect, useRef, type ReactNode } from 'react';
export function GoalPanel({ children, close }: { children: ReactNode; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    const dismissBackdrop = (event: MouseEvent) => {
      if (!element || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    };
    const dismissEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    element?.addEventListener('click', dismissBackdrop);
    element?.addEventListener('keydown', dismissEscape);
    return () => { element?.removeEventListener('click', dismissBackdrop); element?.removeEventListener('keydown', dismissEscape); };
  }, [close]);
  return <dialog ref={dialog} className="orch-goal-panel" aria-label="Goal details" onCancel={event => { event.preventDefault(); close(); }}><header className="orch-panel-header"><strong>Goal details</strong><button onClick={close}>Close goal details</button></header><div className="orch-panel-body">{children}</div></dialog>;
}
