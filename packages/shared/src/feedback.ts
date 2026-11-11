import { z } from 'zod';

// Help & Feedback (Field Ledger): feedback stays on the host. Each submission is kept as an
// audit event (`feedback.submitted`); nothing is emailed or sent to an outside service.
// Administrators read the latest on the Help & Feedback page.

export const FEEDBACK_KINDS = ['not_working', 'confusing', 'idea'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS, { error: 'Choose what kind' });

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  not_working: 'Something is not working',
  confusing: 'Something is confusing',
  idea: 'An idea',
};

export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_PAGE_MAX = 200;
/** How many submissions `GET /api/feedback` returns, newest first. */
export const FEEDBACK_LIST_LIMIT = 50;

/** `POST /api/feedback`. `page` is an in-app path only (no query string, no host). */
export const submitFeedbackRequestSchema = z.strictObject({
  kind: feedbackKindSchema,
  text: z
    .string({ error: 'Say what happened' })
    .trim()
    .min(1, { error: 'Say what happened' })
    .max(FEEDBACK_TEXT_MAX, { error: `Use at most ${FEEDBACK_TEXT_MAX} characters` }),
  page: z
    .string()
    .max(FEEDBACK_PAGE_MAX, { error: `must be at most ${FEEDBACK_PAGE_MAX} characters` })
    .regex(/^\/[^?#\s]*$/, { error: 'must be an in-app path' })
    .optional(),
});
export type SubmitFeedbackRequest = z.input<typeof submitFeedbackRequestSchema>;

export const submitFeedbackResponseSchema = z.object({ id: z.string() });
export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;

export const feedbackItemSchema = z.object({
  id: z.string(),
  submittedAt: z.string(),
  /** Name and initials as they were when it was sent (audit snapshot). */
  name: z.string().nullable(),
  initials: z.string().nullable(),
  accountType: z.enum(['personal', 'shared_lab', 'test', 'system']).nullable(),
  kind: feedbackKindSchema,
  text: z.string(),
  page: z.string().nullable(),
});
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

export const feedbackListSchema = z.array(feedbackItemSchema);
