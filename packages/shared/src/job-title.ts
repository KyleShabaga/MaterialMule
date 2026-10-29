import { z } from 'zod';

// Job titles (D16, MM-AO06): Microsoft's, an administrator's override, and which one shows.
// A title describes a person; it never grants a permission, eligibility or capability.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** D16: an administrator's firm job title for someone, overriding the Microsoft one for display. */
export const jobTitleOverrideSchema = z
  .string({ error: 'Job title must be text' })
  .trim()
  .min(1, { error: 'Enter a job title, or clear the override.' })
  .max(200, { error: 'Job title must be 200 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: "Job title can't contain control characters",
  });

export const JOB_TITLE_SOURCES = ['override', 'microsoft'] as const;
export type JobTitleSource = (typeof JOB_TITLE_SOURCES)[number];
export const JOB_TITLE_SOURCE_LABEL: Record<JobTitleSource, string> = {
  override: 'Set by an administrator',
  microsoft: 'From Microsoft',
};

/** The title shown for a person (D16): the override when set, else Microsoft's. Grants nothing. */
export const effectiveJobTitleSchema = z
  .object({ value: z.string(), source: z.enum(JOB_TITLE_SOURCES) })
  .nullable();
export type EffectiveJobTitle = z.infer<typeof effectiveJobTitleSchema>;

export function effectiveJobTitle(
  microsoft: string | null,
  override: string | null,
): EffectiveJobTitle {
  if (override) return { value: override, source: 'override' };
  if (microsoft) return { value: microsoft, source: 'microsoft' };
  return null;
}
