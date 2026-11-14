import {
  CONCRETE_ADMIXTURE_DOSAGE_UNIT,
  CONCRETE_ADMIXTURE_KINDS,
  CONCRETE_MIX_SPEC_DEFAULTS,
  type ConcreteAdmixtureKind,
  type ConcreteAdmixtures,
  type ConcreteMixSpec,
} from '@materialmule/shared';
import { CircleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const UNANSWERED = 'unanswered';

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
    <form
      className="flex max-w-3xl flex-col gap-5 rounded-lg border bg-card p-5"
      aria-label={title}
      onSubmit={submit}
    >
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-supplier`}>Supplier</FieldLabel>
          <Input
            id={`${id}-supplier`}
            required
            maxLength={200}
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-number`}>Mix number</FieldLabel>
          <Input
            id={`${id}-number`}
            className="font-mono"
            required
            maxLength={100}
            value={mixNumber}
            onChange={(e) => setMixNumber(e.target.value)}
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${id}-plants`}>Plants (separate with commas)</FieldLabel>
          <Input id={`${id}-plants`} value={plants} onChange={(e) => setPlants(e.target.value)} />
        </Field>
        {NUMBER_FIELDS.map(([field, label]) => (
          <Field key={field}>
            <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
            <Input
              id={`${id}-${field}`}
              className="font-mono"
              inputMode="decimal"
              value={numbers[field]}
              onChange={(e) => setNumbers({ ...numbers, [field]: e.target.value })}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${id}-cement`}>Cement type</FieldLabel>
          <Input
            id={`${id}-cement`}
            maxLength={100}
            value={cement}
            onChange={(e) => setCement(e.target.value)}
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${id}-ages`}>Test ages</FieldLabel>
          <Input
            id={`${id}-ages`}
            className="font-mono"
            value={ages}
            aria-describedby={`${id}-ages-hint`}
            onChange={(e) => setAges(e.target.value)}
          />
          <FieldDescription id={`${id}-ages-hint`}>
            One per specimen, e.g. 7, 28, 28, HOLD.{' '}
            {initial ? '' : 'Leave blank to use the project’s default ages.'}
          </FieldDescription>
        </Field>
      </FieldGroup>

      <FieldSet>
        <FieldLegend variant="label">Project specification admixtures</FieldLegend>
        <Field className="max-w-xs">
          <FieldLabel htmlFor={`${id}-declaration`}>Admixtures</FieldLabel>
          <Select
            value={admixtures.declaration ?? UNANSWERED}
            onValueChange={(next) =>
              setAdmixtures(
                next === 'listed'
                  ? { declaration: 'listed', items: admixtures.items }
                  : {
                      declaration: next === UNANSWERED ? null : (next as 'none' | 'unknown'),
                      items: [],
                    },
              )
            }
          >
            <SelectTrigger id={`${id}-declaration`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNANSWERED}>Not answered</SelectItem>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
              <SelectItem value="listed">Listed below</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {admixtures.declaration === 'listed' ? (
          <ul className="flex flex-col gap-2">
            {CONCRETE_ADMIXTURE_KINDS.map((kind) => {
              const item = admixtures.items.find((i) => i.kind === kind);
              const unit = CONCRETE_ADMIXTURE_DOSAGE_UNIT[kind];
              return (
                <li key={kind} className="flex min-h-9 flex-wrap items-center gap-3">
                  <Field orientation="horizontal" className="w-48">
                    <Checkbox
                      id={`${id}-${kind}`}
                      checked={Boolean(item)}
                      onCheckedChange={(on) => setKind(kind, on === true)}
                    />
                    <FieldLabel htmlFor={`${id}-${kind}`} className="font-normal">
                      {ADMIXTURE_LABEL[kind]}
                    </FieldLabel>
                  </Field>
                  {item && unit ? (
                    <Input
                      className="w-32 font-mono"
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
                    <Input
                      className="w-56"
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
      </FieldSet>

      {shown ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{shown}</AlertTitle>
          {fieldErrors && fieldErrors.length > 0 ? (
            <AlertDescription>
              <ul className="list-disc pl-4">
                {fieldErrors.map((e) => (
                  <li key={`${e.field}-${e.message}`}>{e.message}</li>
                ))}
              </ul>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
