import {
  CONCRETE_ADMIXTURE_DOSAGE_UNIT,
  type ConcreteAdmixtureKind,
  type ConcreteAdmixtures,
  type ConcreteMixSpec,
  type ConcreteMixStatus,
  type ConcreteSpecimenAge,
} from '@materialmule/shared';
import type { BadgeTone } from '../../components/ui';

export const ADMIXTURE_LABEL: Record<ConcreteAdmixtureKind, string> = {
  superplasticizer: 'Superplasticizer',
  fibres: 'Fibres',
  accelerator: 'Accelerator',
  ice: 'Ice',
  winter_heat: 'Winter heat',
  air: 'Air entrainer',
  retarder: 'Retarder',
  corrosion_inhibitor: 'Corrosion inhibitor',
  pigment: 'Pigment',
  other: 'Other',
};

export const MIX_STATUS: Record<ConcreteMixStatus, { label: string; tone: BadgeTone }> = {
  unapproved: { label: 'Unapproved', tone: 'closed' },
  approved: { label: 'Approved', tone: 'storage' },
  revision_pending: { label: 'Revision awaiting approval', tone: 'waiting' },
};

const blank = '—';
export const value = (n: number | null, unit = '') => (n === null ? blank : `${n}${unit}`);

export function slumpText(spec: Pick<ConcreteMixSpec, 'slumpTargetMm' | 'slumpToleranceMm'>) {
  if (spec.slumpTargetMm === null) return blank;
  return spec.slumpToleranceMm === null
    ? `${spec.slumpTargetMm} mm`
    : `${spec.slumpTargetMm} ± ${spec.slumpToleranceMm} mm`;
}

export function airText(spec: Pick<ConcreteMixSpec, 'airMinPercent' | 'airMaxPercent'>) {
  if (spec.airMinPercent === null && spec.airMaxPercent === null) return blank;
  return `${spec.airMinPercent ?? '?'}–${spec.airMaxPercent ?? '?'} %`;
}

export function strengthText(
  spec: Pick<ConcreteMixSpec, 'specifiedStrengthMpa' | 'specifiedStrengthAgeDays'>,
) {
  if (spec.specifiedStrengthMpa === null) return blank;
  return spec.specifiedStrengthAgeDays === null
    ? `${spec.specifiedStrengthMpa} MPa`
    : `${spec.specifiedStrengthMpa} MPa at ${spec.specifiedStrengthAgeDays} d`;
}

export function admixturesText(admixtures: ConcreteAdmixtures): string {
  if (admixtures.declaration === null) return 'Not answered';
  if (admixtures.declaration === 'none') return 'None';
  if (admixtures.declaration === 'unknown') return 'Unknown';
  return admixtures.items
    .map((item) => {
      const unit = CONCRETE_ADMIXTURE_DOSAGE_UNIT[item.kind];
      const parts = [ADMIXTURE_LABEL[item.kind]];
      if (item.description) parts[0] = `${parts[0]} (${item.description})`;
      if (item.dosage !== null && unit) parts.push(`${item.dosage} ${unit}`);
      return parts.join(' ');
    })
    .join(', ');
}

export const agesText = (ages: readonly (number | 'HOLD')[]) => ages.map(String).join(' / ');

/** Display one propagation value (spec member, age or revision number). */
export function propagationValue(field: string, raw: unknown): string {
  if (raw === null || raw === undefined) return blank;
  if (field === 'mixRevision') return `Revision ${String(raw)}`;
  if (field === 'assignedAge') return raw === 'HOLD' ? 'HOLD' : `${String(raw)} days`;
  if (field.endsWith('admixtures')) return admixturesText(raw as ConcreteAdmixtures);
  return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
}

export function commaAges(ages: readonly ConcreteSpecimenAge[]): string {
  return ages.map(String).join(', ');
}

/** "7, 28, 28, HOLD" → ages; null when a part isn't a whole number of days or HOLD. */
export function parseAges(text: string): ConcreteSpecimenAge[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: ConcreteSpecimenAge[] = [];
  for (const part of parts) {
    if (part.toUpperCase() === 'HOLD') out.push('HOLD');
    else if (/^\d{1,3}$/.test(part) && Number(part) >= 1) out.push(Number(part));
    else return null;
  }
  return out;
}

export function structureText(elements: string[], other: string | null): string {
  const list = elements.filter((e) => !(other && e === 'Other'));
  if (other) list.push(other);
  return list.join(', ');
}
