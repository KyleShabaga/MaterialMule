// Specimen identity as text, shared by the Breaks, Testing table and Holds screens. A specimen's
// ID is its set's ID followed by its letter (`26-01` + `B` = `26-01B`).

export interface SpecimenIdentityParts {
  temporaryId: string | null;
  permanentId: string | null;
}

/** The specimen's ID as text, as it is typed and searched (also used in accessible names). */
export function specimenText(identity: SpecimenIdentityParts, letter?: string | null): string {
  return identity.permanentId ?? identity.temporaryId ?? `Unnumbered set, ${letter ?? ''}`;
}

/** The set part and the letter of a specimen ID (`26-01B` → `26-01`, `B`). */
export function splitSpecimenId(
  id: string,
  letter?: string | null,
): { set: string; letter: string | null } {
  if (letter && id.endsWith(letter) && id.length > letter.length) {
    return { set: id.slice(0, -letter.length), letter };
  }
  const match = /^(.*\d)([A-Z]{1,2})$/.exec(id);
  return match ? { set: match[1]!, letter: match[2]! } : { set: id, letter: null };
}
