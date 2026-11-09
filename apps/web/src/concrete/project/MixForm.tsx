import {
  CONCRETE_ADMIXTURE_DOSAGE_UNIT,
  CONCRETE_ADMIXTURE_KINDS,
  CONCRETE_MIX_SPEC_DEFAULTS,
  type ConcreteAdmixtureKind,
  type ConcreteAdmixtures,
  type ConcreteMixSpec,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { ADMIXTURE_LABEL, commaAges, parseAges } from './mix-format';

// MM-V2-C30: add or edit a mix's specification (the Lead only; the server checks). Supplier and
// mix number are required; everything else may wait for approval. Editing an approved mix makes
// a draft revision (D14); the approved one stays in effect until the Lead approves.

export type MixSpecInput = Omit<ConcreteMixSpec, 'ticketDefaults'>;

const NUMBER_FIELDS = [
  ['specifiedStrengthMpa', 'Specified strength (MPa)'],
  ['specifiedStrengthAgeDays', 'Strength age (days, optional)'],
  ['slumpTargetMm', 'Slump target (mm)'],
  ['slumpToleranceMm', 'Slump tolerance ± (mm)'],
  ['airMinPercent', 'Air minimum (%)'],
  ['airMaxPercent', 'Air maximum (%)'],
  ['maxAggregateSizeMm', 'Max aggregate size (mm)'],
] as const;
type NumberField = (typeof NUMBER_FIELDS)[number][0];

const toText = (n: number | null) => (n === null ? '' : String(n));

export function MixForm({
  initial,
  title,
  submitLabel,
  busy,
  error,
  fieldErrors,
  onSubmit,
  onCancel,
}: {
  initial: MixSpecInput | null;
  title: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  fieldErrors?: { field: string; message: string }[];
  onSubmit: (
    spec: Partial<MixSpecInput> & Pick<MixSpecInput, 'supplierName' | 'mixNumber'>,
  ) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [supplier, setSupplier] = useState(initial?.supplierName ?? '');
  const [mixNumber, setMixNumber] = useState(initial?.mixNumber ?? '');
  const [plants, setPlants] = useState((initial?.plantNames ?? []).join(', '));
  const [numbers, setNumbers] = useState<Record<NumberField, string>>(
    () =>
      Object.fromEntries(
        NUMBER_FIELDS.map(([field]) => [field, toText(initial?.[field] ?? null)]),
      ) as Record<NumberField, string>,
  );
  const [cement, setCement] = useState(initial?.cementType ?? '');
  const [ages, setAges] = useState(initial ? commaAges(initial.testAges) : '');
  const [admixtures, setAdmixtures] = useState<ConcreteAdmixtures>(
    initial?.specAdmixtures ?? CONCRETE_MIX_SPEC_DEFAULTS.specAdmixtures,
  );
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!supplier.trim() || !mixNumber.trim()) {
      setProblem('Enter the supplier and the mix number.');
      return;
    }
    const spec: Record<string, unknown> = {
      supplierName: supplier.trim(),
      mixNumber: mixNumber.trim(),
      plantNames: plants
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      cementType: cement.trim() || null,
      specAdmixtures: admixtures,
    };
    for (const [field] of NUMBER_FIELDS) {
      const text = numbers[field].trim();
      if (text === '') {
        spec[field] = null;
        continue;
      }
      const n = Number(text);
      if (!Number.isFinite(n)) {
        setProblem('Enter numbers only in the numeric fields.');
        return;
      }
      spec[field] = n;
    }
    if (ages.trim() !== '') {
      const parsed = parseAges(ages);
      if (!parsed) {
        setProblem('Enter each test age as a whole number of days or HOLD, separated by commas.');
        return;
      }
      spec.testAges = parsed;
    }
    // On an edit, send only what changed (a given section replaces the stored one whole).
    if (initial) {
      for (const key of Object.keys(spec)) {
        if (
          key !== 'supplierName' &&
          key !== 'mixNumber' &&
          JSON.stringify(spec[key]) === JSON.stringify(initial[key as keyof MixSpecInput])
        ) {
          delete spec[key];
        }
      }
    }
    setProblem(null);
    onSubmit(spec as Parameters<typeof onSubmit>[0]);
  }

  function setKind(kind: ConcreteAdmixtureKind, on: boolean) {
    const items = on
      ? [...admixtures.items, { kind, dosage: null, description: null }]
      : admixtures.items.filter((item) => item.kind !== kind);
    items.sort(
      (a, b) => CONCRETE_ADMIXTURE_KINDS.indexOf(a.kind) - CONCRETE_ADMIXTURE_KINDS.indexOf(b.kind),
    );
    setAdmixtures({ declaration: 'listed', items });
  }

  function setItem(
    kind: ConcreteAdmixtureKind,
    change: { dosage?: number | null; description?: string | null },
  ) {
    setAdmixtures({
      ...admixtures,
      items: admixtures.items.map((item) => (item.kind === kind ? { ...item, ...change } : item)),
    });
  }

  const shown = problem ?? error;
  return (
    <form className="concrete-form mix-form" aria-label={title} onSubmit={submit}>
      <div className="mix-form-grid">
        <div>
          <label htmlFor={`${id}-supplier`}>Supplier</label>
          <input
            id={`${id}-supplier`}
            type="text"
            required
            maxLength={200}
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${id}-number`}>Mix number</label>
          <input
            id={`${id}-number`}
            type="text"
            required
            maxLength={100}
            value={mixNumber}
            onChange={(e) => setMixNumber(e.target.value)}
          />
        </div>
        <div className="mix-form-wide">
          <label htmlFor={`${id}-plants`}>Plants (separate with commas)</label>
          <input
            id={`${id}-plants`}
            type="text"
            value={plants}
            onChange={(e) => setPlants(e.target.value)}
          />
        </div>
        {NUMBER_FIELDS.map(([field, label]) => (
          <div key={field}>
            <label htmlFor={`${id}-${field}`}>{label}</label>
            <input
              id={`${id}-${field}`}
              type="text"
              inputMode="decimal"
              value={numbers[field]}
              onChange={(e) => setNumbers({ ...numbers, [field]: e.target.value })}
            />
          </div>
        ))}
        <div>
          <label htmlFor={`${id}-cement`}>Cement type</label>
          <input
            id={`${id}-cement`}
            type="text"
            maxLength={100}
            value={cement}
            onChange={(e) => setCement(e.target.value)}
          />
        </div>
        <div className="mix-form-wide">
          <label htmlFor={`${id}-ages`}>Test ages</label>
          <input
            id={`${id}-ages`}
            type="text"
            value={ages}
            aria-describedby={`${id}-ages-hint`}
            onChange={(e) => setAges(e.target.value)}
          />
          <p id={`${id}-ages-hint`} className="field-hint">
            One per specimen, e.g. 7, 28, 28, HOLD.{' '}
            {initial ? '' : 'Leave blank to use the project’s default ages.'}
          </p>
        </div>
      </div>

      <fieldset className="mix-admixtures">
        <legend>Project specification admixtures</legend>
        <label htmlFor={`${id}-declaration`}>Admixtures</label>
        <select
          id={`${id}-declaration`}
          value={admixtures.declaration ?? ''}
          onChange={(e) => {
            const next = e.target.value;
            setAdmixtures(
              next === 'listed'
                ? { declaration: 'listed', items: admixtures.items }
                : { declaration: next === '' ? null : (next as 'none' | 'unknown'), items: [] },
            );
          }}
        >
          <option value="">Not answered</option>
          <option value="none">None</option>
          <option value="unknown">Unknown</option>
          <option value="listed">Listed below</option>
        </select>
        {admixtures.declaration === 'listed' ? (
          <ul className="mix-admixture-list">
            {CONCRETE_ADMIXTURE_KINDS.map((kind) => {
              const item = admixtures.items.find((i) => i.kind === kind);
              const unit = CONCRETE_ADMIXTURE_DOSAGE_UNIT[kind];
              return (
                <li key={kind}>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(item)}
                      onChange={(e) => setKind(kind, e.target.checked)}
                    />{' '}
                    {ADMIXTURE_LABEL[kind]}
                  </label>
                  {item && unit ? (
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${ADMIXTURE_LABEL[kind]} dosage (${unit})`}
                      placeholder={unit}
                      value={item.dosage === null ? '' : String(item.dosage)}
                      onChange={(e) =>
                        setItem(kind, {
                          dosage: e.target.value.trim() === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  ) : null}
                  {item && kind === 'other' ? (
                    <input
                      type="text"
                      aria-label="Other admixture"
                      maxLength={200}
                      value={item.description ?? ''}
                      onChange={(e) => setItem(kind, { description: e.target.value || null })}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </fieldset>

      {shown ? (
        <div className="field-error" role="alert">
          <p>{shown}</p>
          {fieldErrors && fieldErrors.length > 0 ? (
            <ul>
              {fieldErrors.map((e) => (
                <li key={`${e.field}-${e.message}`}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="page-actions">
        <button type="submit" className="primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
