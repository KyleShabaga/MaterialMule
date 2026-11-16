/**
 * MM-T78: the keyboard highlight (aria-activedescendant, marked aria-selected) in the project and
 * test-hole pickers. A solid --option-active fill (3:1 against the list in both schemes) plus an
 * inset left bar, so it never relies on colour alone; hover is a tint with an underline that skips
 * the highlighted option, so the pointer resting on it never hides the highlight. Same tokens as
 * the receiver picker (styles.css .receiver-options).
 */
export const PICKER_OPTION_CLASS =
  'flex min-h-9 cursor-pointer items-center rounded-sm px-2 text-sm aria-selected:bg-(--option-active) aria-selected:text-(--on-option-active) aria-selected:[box-shadow:inset_4px_0_0_currentColor] [&:not([aria-selected=true]):not([aria-disabled=true])]:hover:bg-(--option-hover) [&:not([aria-selected=true]):not([aria-disabled=true])]:hover:underline';
