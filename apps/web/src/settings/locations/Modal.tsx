import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native modal <dialog>: focus stays inside and Escape closes it. */
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
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
    return () => dialog?.close?.();
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
