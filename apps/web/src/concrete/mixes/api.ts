import {
  concreteMixDetailSchema,
  concreteMixListSchema,
  type ConcreteMixDetail,
  type ConcreteMixList,
} from '@materialmule/shared';
import { z } from 'zod';
import { apiFetch } from '../../api/client';

// Project concrete mixes screen (MM-V2-C03 API; MM-V2-C37 discard draft and supplier link). Every
// call resolves; failures carry a readable message.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

const errorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const MESSAGES: Record<string, string> = {
  version_conflict: 'Someone else changed this mix first. Reload and try again.',
  no_approved_revision: 'This mix has no approved revision yet, so its draft stays.',
  revision_not_draft: 'That revision is no longer the open draft. Reload and try again.',
  invalid_supplier: 'Choose an active listed supplier.',
  forbidden: "Only the project's Lead Project Engineer can change its mixes.",
};

export async function fetchProjectMixes(projectId: string): Promise<LoadResult<ConcreteMixList>> {
  try {
    const response = await apiFetch(
      `/api/projects/${encodeURIComponent(projectId)}/concrete-mixes?pageSize=100`,
    );
    if (!response.ok) return { ok: false, message: "The project's mixes couldn't load." };
    const parsed = concreteMixListSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

async function write(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<LoadResult<ConcreteMixDetail>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method, body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = concreteMixDetailSchema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  }
  const error = errorSchema.safeParse(json);
  const code = error.success ? error.data.code : undefined;
  return {
    ok: false,
    message:
      (code && MESSAGES[code]) ||
      (error.success ? (error.data.errors?.[0]?.message ?? error.data.message) : undefined) ||
      "The change couldn't be saved.",
  };
}

/** Discard the open draft revision of an approved mix (the Lead; MM-V2-C37). */
export function discardMixDraft(
  mix: ConcreteMixDetail | ConcreteMixList['items'][number],
  note: string,
  idempotencyKey: string,
): Promise<LoadResult<ConcreteMixDetail>> {
  return write(`/api/concrete-mixes/${encodeURIComponent(mix.id)}/discard-draft`, 'POST', {
    idempotencyKey,
    version: mix.version,
    revisionId: mix.draftRevision?.id,
    note: note.trim() === '' ? null : note,
  });
}

/** Link a listed supplier to the mix, or null to unlink (MM-V2-C37). */
export function linkMixSupplier(
  mix: ConcreteMixList['items'][number],
  supplierId: string | null,
  idempotencyKey: string,
): Promise<LoadResult<ConcreteMixDetail>> {
  return write(`/api/concrete-mixes/${encodeURIComponent(mix.id)}`, 'PATCH', {
    idempotencyKey,
    version: mix.version,
    supplierId,
  });
}
