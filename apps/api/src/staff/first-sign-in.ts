// First Microsoft sign-in linking rule (MM-T07). A pre-provisioned staff entry is linked only
// when the signed-in UPN equals the entry's expected UPN and the entry has no sign-in identity
// yet. Initials and names are never compared: two "JS" staff are two people.

export interface PreprovisionedCandidate {
  userId: string;
  expectedUpn: string | null;
  /** True when the entry already has any sign-in identity attached. */
  linked: boolean;
}

/** UPNs are case-insensitive in Entra ID; surrounding spaces are never meaningful. */
export function normalizeUpn(upn: string): string {
  return upn.trim().toLowerCase();
}

/**
 * The entry to link for a first sign-in with `upn`, or null when a new pending user must be
 * created instead. Ambiguity (more than one unlinked match) links nothing.
 */
export function findPreprovisionedMatch(
  upn: string,
  candidates: readonly PreprovisionedCandidate[],
): string | null {
  const wanted = normalizeUpn(upn);
  if (wanted === '') {
    return null;
  }
  const matches = candidates.filter(
    (candidate) =>
      !candidate.linked &&
      candidate.expectedUpn !== null &&
      normalizeUpn(candidate.expectedUpn) === wanted,
  );
  return matches.length === 1 ? matches[0]!.userId : null;
}
