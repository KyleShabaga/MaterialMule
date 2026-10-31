import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Native modal <dialog>: focus stays inside and Escape closes it. The page unmounts it to close
 * it, so focus goes back to whatever opened it (MTR-136), not the page body.
 */
export function Modal({
  title,
  className = 'drawer',
  onClose,
  children,
}: {
  title: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
    return () => {
      dialog?.close?.();
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="drawer-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
