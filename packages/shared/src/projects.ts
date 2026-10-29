import { z } from 'zod';
import { positionSchema } from './profile';
import { PROJECT_INVOLVEMENTS, leadNominationSchema, nominationNoteSchema } from './project-access';

// Projects and test holes for receiving (MM-T08). The API and the web app share these so both
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
  /** Their position, where the list offers one (`GET /api/staff/active`, MM-T61); null if unset. */
  position: positionSchema.nullable().optional(),
});
export type StaffOption = z.infer<typeof staffOptionSchema>;

/** `GET /api/staff/active`: active staff who can be a Lead Project Engineer or receiver (not the LAB account). */
export const staffOptionsResponseSchema = z.array(staffOptionSchema);

export const projectSummarySchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  name: z.string(),
  client: z.string(),
  /** Null while the project waits for a Lead Project Engineer (D02, MM-AO04). */
  leadProjectEngineer: staffOptionSchema.nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** `GET /api/projects/search?q=&limit=10`. */
export const projectSearchResponseSchema = z.array(projectSummarySchema);

export const PROJECT_SEARCH_DEFAULT_LIMIT = 10;
export const PROJECT_SEARCH_MAX_LIMIT = 10;

/**
 * `POST /api/projects` body. `receiverUserId` is the receiver selected in the draft, if any.
 *
 * Lead (MM-AO04, D01/D02): the creator may nominate a Lead Project Engineer (`leadNomineeUserId`,
 * a suggestion for an admin to confirm that grants nothing), or leave it empty. Only a person
 * holding "Can create and lead projects" may instead appoint themselves (`appointSelfAsLead`),
 * and only while creating. Otherwise the project is saved waiting for a lead.
 */
export const createProjectRequestSchema = z
  .object({
    projectNumber: projectNumberSchema,
    name: trimmedText('Project name', 200),
    client: trimmedText('Client', 200),
    leadNomineeUserId: z.uuid({ error: 'Choose a staff member' }).nullish(),
    nominationNote: nominationNoteSchema,
    appointSelfAsLead: z.boolean().default(false),
    receiverUserId: z.uuid().nullish(),
  })
  .refine((value) => !(value.appointSelfAsLead && value.leadNomineeUserId), {
    path: ['leadNomineeUserId'],
    message: 'Either lead the project yourself or nominate someone, not both',
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

/**
 * 400 body for invalid input, the same shape receipts use (`ReceiptErrorBody`, MM-T09): one
 * entry per problem with its field path. Never echoes the submitted values.
 */
export const validationErrorResponseSchema = z.object({
  code: z.literal('validation_failed'),
  errors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
});
export type ValidationErrorResponse = z.infer<typeof validationErrorResponseSchema>;

/** Messages grouped by field, for showing next to each input. */
export function messagesByField(
  errors: readonly { field: string; message: string }[],
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const error of errors) {
    (grouped[error.field || '_'] ??= []).push(error.message);
  }
  return grouped;
}

/** "67997 · West Pine Creek Ph.3 · Jacobs", as the project picker lists matches. */
export function projectLabel(project: Pick<ProjectSummary, 'projectNumber' | 'name' | 'client'>) {
  return `${project.projectNumber} · ${project.name} · ${project.client}`;
}

// ---------------------------------------------------------------------------------------------
// Projects list and project detail (MM-T35)
// ---------------------------------------------------------------------------------------------

export const PROJECT_LIST_SORTS = ['number', 'name', 'last_receipt'] as const;
export type ProjectListSort = (typeof PROJECT_LIST_SORTS)[number];
export const PROJECT_LIST_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const PROJECT_LIST_PAGE_SIZE_DEFAULT = 25;
export const PROJECT_LIST_PAGE_SIZE_MAX = 100;
/** Newest receipts shown on the project detail page; the total is reported alongside. */
export const PROJECT_DETAIL_RECEIPT_LIMIT = 100;
export const SERVER_FOLDER_PATH_MAX = 500;
export const PROJECT_NUMBER_LOCKED_MESSAGE =
  "Project number is printed on existing labels and can't be changed";

const blankParam = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const queryBoolean = (value: unknown) => {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return blankParam(value);
};

/**
 * `GET /api/projects?search=&mine=&sort=&dir=&page=&pageSize=`. The web app parses its URL with
 * the same schema, so a shared link shows what the server returns.
 */
export const projectListQuerySchema = z.object({
  search: z.preprocess(
    blankParam,
    z.string().trim().max(200, { error: 'must be at most 200 characters' }).optional(),
  ),
  /**
   * "My projects" (D12, MM-AO03): only projects the signed-in user is actively involved in as
   * Lead Project Engineer, team member, reviewer, acceptance delegate or report issuer.
   */
  mine: z.preprocess(queryBoolean, z.boolean({ error: 'must be true or false' }).default(false)),
  /** Only projects with no effective Lead Project Engineer (D02, MM-AO04). */
  waitingForLead: z.preprocess(
    queryBoolean,
    z.boolean({ error: 'must be true or false' }).default(false),
  ),
  sort: z.preprocess(
    blankParam,
    z.enum(PROJECT_LIST_SORTS, { error: 'must be number, name or last_receipt' }).default('number'),
  ),
  /** Defaults to A–Z for number and name, newest first for last receipt. */
  dir: z.preprocess(
    blankParam,
    z.enum(PROJECT_LIST_SORT_DIRECTIONS, { error: 'must be asc or desc' }).optional(),
  ),
  page: z.preprocess(
    blankParam,
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
  pageSize: z.preprocess(
    blankParam,
    z.coerce
      .number({ error: 'must be a number' })
      .int()
      .min(1)
      .max(PROJECT_LIST_PAGE_SIZE_MAX, { error: `must be at most ${PROJECT_LIST_PAGE_SIZE_MAX}` })
      .default(PROJECT_LIST_PAGE_SIZE_DEFAULT),
  ),
});
export type ProjectListQuery = z.output<typeof projectListQuerySchema>;

export function projectListSortDirection(query: Pick<ProjectListQuery, 'sort' | 'dir'>) {
  return query.dir ?? (query.sort === 'last_receipt' ? 'desc' : 'asc');
}

export const projectListItemSchema = projectSummarySchema.extend({
  /**
   * How the signed-in user is involved in this project now (D12), de-duplicated, in
   * PROJECT_INVOLVEMENTS order; empty when not involved. Relevance only: it grants nothing.
   */
  involvement: z.array(z.enum(PROJECT_INVOLVEMENTS)),
  testHoleCount: z.number(),
  /** Storage units with status In stock. */
  inStockUnitCount: z.number(),
  /** Latest receipt's received date (YYYY-MM-DD), or null before the first receipt. */
  lastReceiptDate: z.string().nullable(),
});
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

export const projectListPageSchema = z.object({
  items: z.array(projectListItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ProjectListPage = z.infer<typeof projectListPageSchema>;

export const projectDetailTestHoleSchema = testHoleSchema.extend({
  /** Storage units (any status) with a SAMPLE#/DEPTH summary for this hole. */
  unitCount: z.number(),
});
export type ProjectDetailTestHole = z.infer<typeof projectDetailTestHoleSchema>;

export const projectDetailReceiptSchema = z.object({
  id: z.string(),
  receivedDate: z.string(),
  receiver: z.object({ name: z.string(), initials: z.string() }),
  unitCount: z.number(),
});
export type ProjectDetailReceipt = z.infer<typeof projectDetailReceiptSchema>;

/** `GET /api/projects/:id`: a superset of ProjectSummary, so summary callers keep working. */
export const projectDetailSchema = projectSummarySchema.extend({
  serverFolderPath: z.string().nullable(),
  /** Optimistic concurrency token; send it back with an edit. */
  version: z.number(),
  /** True once any receipt exists: the number is printed on labels. */
  numberLocked: z.boolean(),
  /** The pending Lead Project Engineer nomination, if any (D01): it grants nothing. */
  leadNomination: leadNominationSchema.nullable(),
  /** What the signed-in user may change (the server checks again on save). */
  canEdit: z.boolean(),
  canChangeLeadProjectEngineer: z.boolean(),
  /** Storage units of any status, and those In stock. */
  unitCount: z.number(),
  inStockUnitCount: z.number(),
  testHoles: z.array(projectDetailTestHoleSchema),
  /** Newest first, at most PROJECT_DETAIL_RECEIPT_LIMIT; receiptCount is the full total. */
  receipts: z.array(projectDetailReceiptSchema),
  receiptCount: z.number(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

// Like CONTROL_CHARACTERS, but a reason may span lines.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/**
 * `PATCH /api/projects/:id`. Only fields present are changed. Admins and the project's Lead Project Engineer may
 * edit; only admins change the Lead Project Engineer, and that needs a reason (owner decision 2026-10-25).
 */
export const updateProjectRequestSchema = z.object({
  version: z.number({ error: 'Version is required' }).int().min(1),
  projectNumber: projectNumberSchema.optional(),
  name: trimmedText('Project name', 200).optional(),
  client: trimmedText('Client', 200).optional(),
  /** Blank clears the path. */
  serverFolderPath: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
      z
        .string({ error: 'Server folder path must be text' })
        .trim()
        .max(SERVER_FOLDER_PATH_MAX, {
          error: `Server folder path must be ${SERVER_FOLDER_PATH_MAX} characters or fewer`,
        })
        .pipe(noControlCharacters('Server folder path'))
        .nullable(),
    )
    .optional(),
  /** Admin only, with a reason; null removes the lead so the project waits for one (D02). */
  leadProjectEngineerId: staffId('Lead Project Engineer').nullable().optional(),
  reason: z.preprocess(
    blankParam,
    z
      .string({ error: 'Reason must be text' })
      .trim()
      .max(2000, { error: 'Reason must be 2000 characters or fewer' })
      .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
        message: "Reason can't contain control characters",
      })
      .optional(),
  ),
});
export type UpdateProjectRequest = z.input<typeof updateProjectRequestSchema>;

/** 409 body when the project changed since it was loaded. */
export const projectVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: projectDetailSchema,
});
export type ProjectVersionConflictResponse = z.infer<typeof projectVersionConflictResponseSchema>;
