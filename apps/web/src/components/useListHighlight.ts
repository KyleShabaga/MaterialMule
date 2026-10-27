import { useState } from 'react';

/**
 * The highlighted option of a combobox list, shared by every receiving picker (MM-T62) so they
 * answer the keyboard the same way: when the options change, the first one is highlighted, so
 * Enter picks the first match and ArrowDown+Enter the second. ArrowDown and ArrowUp move and wrap.
 *
 * `listKey` identifies the current options (e.g. the query and the option IDs); a new key starts
 * the highlight again at the first option. With `startAtFirst` false (a list opened before
 * anything was typed) nothing is highlighted until an arrow key is pressed.
 */
export function useListHighlight(count: number, listKey: string, startAtFirst = true) {
  const start = startAtFirst ? 0 : -1;
  const [state, setState] = useState({ key: listKey, index: start });
  const index = state.key === listKey ? state.index : start;
  const active = count === 0 ? -1 : Math.min(index, count - 1);

  return {
    /** Index of the highlighted option, or -1 when there are none. */
    active,
    next() {
      if (count > 0) setState({ key: listKey, index: (active + 1) % count });
    },
    previous() {
      if (count > 0) setState({ key: listKey, index: active <= 0 ? count - 1 : active - 1 });
    },
    /** Highlight an option directly, e.g. under the mouse. */
    set(to: number) {
      setState({ key: listKey, index: to });
    },
  };
}
