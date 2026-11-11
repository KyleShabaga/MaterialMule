import { SpecimenId } from '../ledger';
import { splitSpecimenId, type SpecimenIdentityParts } from './specimen-text';

/**
 * Specimen identity for the Breaks, Testing table and Holds screens: the set ID in mono, then the
 * letter in an ink square (SpecimenId). Its text reads as one ID (`26-01B`).
 */
export function SpecimenLabel({
  identity,
  letter,
}: {
  identity: SpecimenIdentityParts;
  letter?: string | null;
}) {
  const id = identity.permanentId ?? identity.temporaryId;
  if (!id) return <SpecimenId set="Unnumbered set" letter={letter} />;
  const parts = splitSpecimenId(id, letter);
  return <SpecimenId set={parts.set} letter={parts.letter} />;
}
