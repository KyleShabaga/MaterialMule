import { z } from 'zod';

// Projects and test holes for receiving (TRP-T08). The API and the web app share these so both
// trim and compare names the same way the database does (project_number_normalized and
// test_hole.name_normalized are lower(trimmed value)).

// Control characters (C0, DEL, C1). Tabs and newlines inside a value are rejected too.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** Project numbers are stored exactly as entered once trimmed. */
export function normalizeProjectNumber(value: string): string {
  return value.trim();
}

/** Case-insensitive key matching project.project_number_normalized. */
export function projectNumberKey(value: string): string {
  return normalizeProjectNumber(value).toLowerCase();
}

/** Test-hole names are stored exactly as entered once trimmed: never rewritten (no year changes). */
export function normalizeTestHoleName(value: string): string {
  return value.trim();
}

/** Case-insensitive key matching test_hole.name_normalized (unique within a project). */
export function testHoleNameKey(value: string): string {
  return normalizeTestHoleName(value).toLowerCase();
}

const noControlCharacters = (label: string) =>
  z.string().refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: `${label} can't contain control characters`,
  });

function trimmedText(label: string, max: number) {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(max, { error: `${label} must be ${max} characters or fewer` })
    .pipe(noControlCharacters(label));
}

export const projectNumberSchema = trimmedText('Project number', 40);
export const testHoleNameSchema = trimmedText('Test hole name', 40);

const staffId = (label: string) => z.uuid({ error: `${label} is required` });

/** A staff member as pickers show them. */
export const staffOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string().nullable(),
});
export type StaffOption = z.infer<typeof staffOptionSchema>;

/** `GET /api/staff/active`: active staff who can be a PM/PE or receiver (not the LAB account). */
export const staffOptionsResponseSchema = z.array(staffOptionSchema);

export const projectSummarySchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  name: z.string(),
  client: z.string(),
  pmPe: staffOptionSchema,
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** `GET /api/projects/search?q=&limit=10`. */
export const projectSearchResponseSchema = z.array(projectSummarySchema);

export const PROJECT_SEARCH_DEFAULT_LIMIT = 10;
export const PROJECT_SEARCH_MAX_LIMIT = 10;

/** `POST /api/projects` body. `receiverUserId` is the receiver selected in the draft, if any. */
export const createProjectRequestSchema = z.object({
  projectNumber: projectNumberSchema,
  name: trimmedText('Project name', 200),
  client: trimmedText('Client', 200),
  pmPeUserId: staffId('PM/PE'),
  receiverUserId: z.uuid().nullish(),
});
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

export const testHoleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
});
export type TestHole = z.infer<typeof testHoleSchema>;

/** `GET /api/projects/:id/test-holes?q=`. */
export const testHoleListResponseSchema = z.array(testHoleSchema);

/** `POST /api/projects/:id/test-holes` body. */
export const createTestHoleRequestSchema = z.object({
  name: testHoleNameSchema,
  receiverUserId: z.uuid().nullish(),
});
export type CreateTestHoleRequest = z.input<typeof createTestHoleRequestSchema>;

/** 409 body when the project number already exists (compared ignoring case). */
export const projectConflictResponseSchema = z.object({
  code: z.literal('project_exists'),
  existing: projectSummarySchema,
});
export type ProjectConflictResponse = z.infer<typeof projectConflictResponseSchema>;

/** 409 body when the hole name already exists in the project (compared ignoring case). */
export const testHoleConflictResponseSchema = z.object({
  code: z.literal('test_hole_exists'),
  existing: testHoleSchema,
});
export type TestHoleConflictResponse = z.infer<typeof testHoleConflictResponseSchema>;

/** 400 body for invalid input: messages keyed by field name. Never echoes the values. */
export const validationErrorResponseSchema = z.object({
  code: z.literal('validation_failed'),
  fieldErrors: z.record(z.string(), z.array(z.string())),
});
export type ValidationErrorResponse = z.infer<typeof validationErrorResponseSchema>;

/** "67997 · West Pine Creek Ph.3 · Jacobs", as the project picker lists matches. */
export function projectLabel(project: Pick<ProjectSummary, 'projectNumber' | 'name' | 'client'>) {
  return `${project.projectNumber} · ${project.name} · ${project.client}`;
}
