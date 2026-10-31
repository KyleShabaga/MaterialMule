import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * After a failed submit, moves focus to the form's first field marked aria-invalid (MTR-133), so
 * keyboard and screen-reader users are taken to the problem. Call `focusFirstInvalid()` when
 * the errors are set; focus moves once they have rendered.
 */
export function useFocusFirstInvalid<T extends HTMLElement = HTMLFormElement>() {
  const ref = useRef<T>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (request === 0) return;
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [request]);
  const focusFirstInvalid = useCallback(() => setRequest((count) => count + 1), []);
  return { formRef: ref, focusFirstInvalid };
}
