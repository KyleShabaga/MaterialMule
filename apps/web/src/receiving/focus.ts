/**
 * Moves focus to a field (or the first input inside its wrapper) and scrolls it into view.
 * Returns false when the element isn't in the document (yet).
 */
export function focusField(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  const focusable = target.matches('input, select, textarea, button')
    ? target
    : target.querySelector<HTMLElement>('input, select, textarea, button');
  (focusable ?? target).focus();
  target.scrollIntoView?.({ block: 'center' });
  return true;
}
