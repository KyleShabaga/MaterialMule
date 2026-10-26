/** Moves focus to a field (or the first input inside its wrapper) and scrolls it into view. */
export function focusField(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const focusable = target.matches('input, select, textarea, button')
    ? target
    : target.querySelector<HTMLElement>('input, select, textarea, button');
  (focusable ?? target).focus();
  target.scrollIntoView?.({ block: 'center' });
}
