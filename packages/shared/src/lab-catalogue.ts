import { z } from 'zod';

// Lab test catalogue and testing templates (MM-T23).
//
// A test entry belongs to one group and optionally one subgroup of that group. It keeps its exact
// source code and complete description as separate fields; an optional concise display name may
// be added, and the description is shown when there is none. No costs exist anywhere in the
// catalogue. Entries are retired, never deleted, so requests keep their original reference.

export const TEST_CODE_MAX_LENGTH = 40;
export const TEST_NAME_MAX_LENGTH = 120;
export const TEST_DESCRIPTION_MAX_LENGTH = 2000;
export const TEST_GROUP_NAME_MAX_LENGTH = 100;
export const TEMPLATE_NAME_MAX_LENGTH = 120;
export const SAMPLE_TAG_GROUP_MAX_LENGTH = 60;

/**
 * How a test is put on printed sample ID tags (MM-T69): no tag, a tag of its own (the default, so
 * an unconfigured test is never combined), or one tag shared with the other tests of its named
 * group for the same sample and depth.
 */
export const SAMPLE_TAG_MODES = ['none', 'own', 'shared'] as const;
export type SampleTagMode = (typeof SAMPLE_TAG_MODES)[number];

export const SAMPLE_TAG_MODE_LABEL: Record<SampleTagMode, string> = {
  none: 'No tag',
  own: 'Own tag',
  shared: 'Shared tag group',
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const text = (max: number) =>
  z
    .string({ error: 'is required' })
    .trim()
    .min(1, { error: 'is required' })
    .max(max, { error: `must be at most ${max} characters` })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      error: "can't contain control characters",
    });

/** Exact code: only surrounding spaces are removed; case, hyphens and underscores are kept. */
const codeSchema = text(TEST_CODE_MAX_LENGTH);
/** Optional display name: blank becomes null. */
const optionalName = z
  .string({ error: 'must be text' })
  .trim()
  .max(TEST_NAME_MAX_LENGTH, { error: `must be at most ${TEST_NAME_MAX_LENGTH} characters` })
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    error: "can't contain control characters",
  })
  .nullish()
  .transform((value) => (value ? value : null));
const descriptionSchema = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'is required' })
  .max(TEST_DESCRIPTION_MAX_LENGTH, {
    error: `must be at most ${TEST_DESCRIPTION_MAX_LENGTH} characters`,
  });
const sortOrderSchema = z
  .number({ error: 'must be a number' })
  .int({ error: 'must be a whole number' })
  .min(0, { error: 'must be 0 or more' })
  .max(100_000, { error: 'must be at most 100000' });
const sampleTagModeSchema = z.enum(SAMPLE_TAG_MODES, { error: 'must be none, own or shared' });
const sampleTagGroupSchema = z
  .string({ error: 'must be text' })
  .trim()
  .max(SAMPLE_TAG_GROUP_MAX_LENGTH, {
    error: `must be at most ${SAMPLE_TAG_GROUP_MAX_LENGTH} characters`,
  })
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    error: "can't contain control characters",
  })
  .nullish()
  .transform((value) => (value ? value : null));

/** A shared mode needs a group name; the other modes take none. */
function checkSampleTag(
  body: { sampleTagMode?: SampleTagMode; sampleTagGroup?: string | null },
  ctx: z.RefinementCtx,
) {
  if (body.sampleTagMode === undefined) {
    if (body.sampleTagGroup !== undefined && body.sampleTagGroup !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sampleTagMode'],
        message: 'is required with a tag group',
        params: { code: 'required' },
      });
    }
    return;
  }
  const group = body.sampleTagGroup ?? null;
  if (body.sampleTagMode === 'shared' && group === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['sampleTagGroup'],
      message: 'is required for a shared tag',
      params: { code: 'required' },
    });
  }
  if (body.sampleTagMode !== 'shared' && group !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['sampleTagGroup'],
      message: 'is only for a shared tag',
      params: { code: 'not_allowed' },
    });
  }
}

const versionSchema = z.number({ error: 'is required' }).int().min(1);
const idSchema = z.uuid({ error: 'must be an ID' });

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const testSubgroupSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  version: z.number().int(),
});
export type TestSubgroup = z.infer<typeof testSubgroupSchema>;

export const testGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  version: z.number().int(),
  subgroups: z.array(testSubgroupSchema),
});
export type TestGroup = z.infer<typeof testGroupSchema>;

export const testTypeSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  groupName: z.string(),
  subgroupId: z.string().nullable(),
  subgroupName: z.string().nullable(),
  code: z.string(),
  /** Concise display name, when one was added. */
  name: z.string().nullable(),
  description: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  retiredAt: z.string().nullable(),
  version: z.number().int(),
  sampleTagMode: z.enum(SAMPLE_TAG_MODES).default('own'),
  /** The shared tag group's name; null unless `sampleTagMode` is shared. */
  sampleTagGroup: z.string().nullable().default(null),
});
export type TestType = z.infer<typeof testTypeSchema>;

/** `GET /api/test-catalogue`: every group (with subgroups) and every entry, retired included. */
export const testCatalogueSchema = z.object({
  groups: z.array(testGroupSchema),
  tests: z.array(testTypeSchema),
});
export type TestCatalogue = z.infer<typeof testCatalogueSchema>;

export const testTemplateItemSchema = z.object({
  testTypeId: z.string(),
  code: z.string(),
  displayName: z.string(),
  active: z.boolean(),
});
export type TestTemplateItem = z.infer<typeof testTemplateItemSchema>;

export const testTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  retiredAt: z.string().nullable(),
  version: z.number().int(),
  items: z.array(testTemplateItemSchema),
});
export type TestTemplate = z.infer<typeof testTemplateSchema>;
export const testTemplateListSchema = z.array(testTemplateSchema);

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const createTestGroupRequestSchema = z.strictObject({
  name: text(TEST_GROUP_NAME_MAX_LENGTH),
  sortOrder: sortOrderSchema.optional(),
});
export type CreateTestGroupRequest = z.output<typeof createTestGroupRequestSchema>;

export const updateTestGroupRequestSchema = z
  .strictObject({
    version: versionSchema,
    name: text(TEST_GROUP_NAME_MAX_LENGTH).optional(),
    sortOrder: sortOrderSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.sortOrder !== undefined, {
    error: 'Change at least one field.',
  });
export type UpdateTestGroupRequest = z.output<typeof updateTestGroupRequestSchema>;

export const createTestSubgroupRequestSchema = z.strictObject({
  groupId: idSchema,
  name: text(TEST_GROUP_NAME_MAX_LENGTH),
  sortOrder: sortOrderSchema.optional(),
});
export type CreateTestSubgroupRequest = z.output<typeof createTestSubgroupRequestSchema>;

export const updateTestSubgroupRequestSchema = updateTestGroupRequestSchema;
export type UpdateTestSubgroupRequest = UpdateTestGroupRequest;

export const createTestTypeRequestSchema = z
  .strictObject({
    groupId: idSchema,
    subgroupId: idSchema.nullish().transform((value) => value ?? null),
    code: codeSchema,
    name: optionalName,
    description: descriptionSchema,
    sortOrder: sortOrderSchema.optional(),
    sampleTagMode: sampleTagModeSchema.default('own'),
    sampleTagGroup: sampleTagGroupSchema,
  })
  .superRefine(checkSampleTag);
export type CreateTestTypeRequest = z.output<typeof createTestTypeRequestSchema>;
export type CreateTestTypeRequestInput = z.input<typeof createTestTypeRequestSchema>;

export const updateTestTypeRequestSchema = z
  .strictObject({
    version: versionSchema,
    groupId: idSchema.optional(),
    subgroupId: idSchema.nullable().optional(),
    code: codeSchema.optional(),
    name: optionalName.optional(),
    description: descriptionSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    /** Changed together: a mode alone clears the group unless it is shared. */
    sampleTagMode: sampleTagModeSchema.optional(),
    sampleTagGroup: sampleTagGroupSchema.optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    error: 'Change at least one field.',
  })
  .superRefine(checkSampleTag);
export type UpdateTestTypeRequest = z.output<typeof updateTestTypeRequestSchema>;
export type UpdateTestTypeRequestInput = z.input<typeof updateTestTypeRequestSchema>;

/** Retire or restore a test entry or template. */
export const versionedRequestSchema = z.strictObject({ version: versionSchema });
export type VersionedRequest = z.output<typeof versionedRequestSchema>;

const testTypeIdsSchema = z
  .array(idSchema, { error: 'must be a list of test IDs' })
  .max(200, { error: 'can hold at most 200 tests' })
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'lists a test more than once',
        params: { code: 'duplicate_test' },
      });
    }
  });

export const createTestTemplateRequestSchema = z.strictObject({
  name: text(TEMPLATE_NAME_MAX_LENGTH),
  testTypeIds: testTypeIdsSchema,
});
export type CreateTestTemplateRequest = z.output<typeof createTestTemplateRequestSchema>;

export const updateTestTemplateRequestSchema = z
  .strictObject({
    version: versionSchema,
    name: text(TEMPLATE_NAME_MAX_LENGTH).optional(),
    testTypeIds: testTypeIdsSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.testTypeIds !== undefined, {
    error: 'Change at least one field.',
  });
export type UpdateTestTemplateRequest = z.output<typeof updateTestTemplateRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Display and search
// ---------------------------------------------------------------------------------------------

/** The concise name when there is one, otherwise the full description. */
export function testDisplayName(test: Pick<TestType, 'name' | 'description'>): string {
  return test.name ?? test.description;
}

/** "Soils › Atterberg limits" or "Soils". */
export function testGroupPath(groupName: string, subgroupName: string | null): string {
  return subgroupName ? `${groupName} › ${subgroupName}` : groupName;
}

/**
 * Entries matching every word of `query` in their code, display name or description, ignoring
 * case. An empty query matches everything.
 */
export function searchTests<T extends Pick<TestType, 'code' | 'name' | 'description'>>(
  tests: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tests];
  return tests.filter((test) => {
    const haystack = `${test.code}\n${test.name ?? ''}\n${test.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Applying a template: the active tests to add, and the retired ones the person must remove or
 * replace (never added silently, never dropped silently).
 */
export function applyTemplate(template: Pick<TestTemplate, 'items'>): {
  add: string[];
  retired: TestTemplateItem[];
} {
  return {
    add: template.items.filter((item) => item.active).map((item) => item.testTypeId),
    retired: template.items.filter((item) => !item.active),
  };
}
