import type { FeedbackKind } from '@materialmule/shared';
import { createContext, useContext } from 'react';

/** The dialog's own words for the kinds (STRATA-104); the API keeps its enum. */
export type FeedbackChoice = 'problem' | 'idea' | 'question';

export const FEEDBACK_CHOICES: readonly { value: FeedbackChoice; label: string }[] = [
  { value: 'problem', label: 'Problem' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
];

/** Problem → not_working, Idea → idea, Question → confusing (the existing API enum). */
export const FEEDBACK_KIND_OF: Record<FeedbackChoice, FeedbackKind> = {
  problem: 'not_working',
  idea: 'idea',
  question: 'confusing',
};

/** The other way, for the administrators' list. */
export const FEEDBACK_CHOICE_OF: Record<FeedbackKind, FeedbackChoice> = {
  not_working: 'problem',
  idea: 'idea',
  confusing: 'question',
};

export function feedbackChoiceLabel(kind: FeedbackKind): string {
  const choice = FEEDBACK_CHOICE_OF[kind];
  return FEEDBACK_CHOICES.find((entry) => entry.value === choice)?.label ?? 'Feedback';
}

export interface OpenFeedbackOptions {
  /** Preselects the kind (Help's "Ask a question" opens on Question). */
  choice?: FeedbackChoice;
  /** Where focus goes back on close; default: whatever had focus when it opened. */
  returnFocus?: HTMLElement | null;
}

export interface FeedbackDialogController {
  isOpen: boolean;
  open(options?: OpenFeedbackOptions): void;
  close(): void;
}

export const FeedbackDialogContext = createContext<FeedbackDialogController | null>(null);

/** The shell's Feedback & bugs dialog, or null outside the shell (signed-out pages, tests). */
export function useOptionalFeedbackDialog(): FeedbackDialogController | null {
  return useContext(FeedbackDialogContext);
}
