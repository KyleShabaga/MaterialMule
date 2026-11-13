import {
  SAMPLE_TAG_MODES,
  testGroupPath,
  type SampleTagMode,
  type TestCatalogue,
  type TestType,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fieldErrors, problem, type WriteFailure } from './catalogue';
import { ProblemAlert } from './parts';

// Add or edit one catalogue test (MM-T23) with its sample ID tag mode (MM-T69), in the Lab tests
// drawer. The person's input stays after a refused save; a conflict reloads the catalogue, and the
// next save uses the refreshed version.

export interface TestBody {
  groupId: string;
  subgroupId: string | null;
  code: string;
  name: string | null;
  description: string;
  sampleTagMode: SampleTagMode;
  sampleTagGroup: string | null;
}

/** The words in the Sample ID tag menu (R9 board: "Shared with its tag group"). */
const TAG_MODE_CHOICE: Record<SampleTagMode, string> = {
  none: 'No tag',
  own: 'Own tag',
  shared: 'Shared with its tag group',
};

const PLACED = ['code', 'name', 'description', 'sampleTagGroup'];

export function TestForm({
  catalogue,
  test,
  onSubmit,
}: {
  catalogue: TestCatalogue;
  /** null: the Add a test form. */
  test: TestType | null;
  /** Resolves null when saved, or the refusal. */
  onSubmit: (body: TestBody) => Promise<WriteFailure | null>;
}) {
  const id = useId();
  const initialPlace = test
    ? test.subgroupId
      ? `${test.groupId}:${test.subgroupId}`
      : test.groupId
    : (catalogue.groups[0]?.id ?? '');
  const [place, setPlace] = useState(initialPlace);
  const [code, setCode] = useState(test?.code ?? '');
  const [name, setName] = useState(test?.name ?? '');
  const [description, setDescription] = useState(test?.description ?? '');
  const [tagMode, setTagMode] = useState<SampleTagMode>(test?.sampleTagMode ?? 'own');
  const [tagGroup, setTagGroup] = useState(test?.sampleTagGroup ?? '');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const missing =
    !place || !code.trim() || !description.trim() || (tagMode === 'shared' && !tagGroup.trim());
  // Existing shared groups, offered so the same group is typed the same way.
  const tagGroups = [
    ...new Set(catalogue.tests.flatMap((t) => (t.sampleTagGroup ? [t.sampleTagGroup] : []))),
  ].sort((a, b) => a.localeCompare(b));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setErrors({});
    setError(null);
    const [groupId, subgroupId] = place.split(':');
    const refused = await onSubmit({
      groupId: groupId!,
      subgroupId: subgroupId ?? null,
      code,
      name: name.trim() || null,
      description,
      sampleTagMode: tagMode,
      sampleTagGroup: tagMode === 'shared' ? tagGroup.trim() : null,
    });
    setBusy(false);
    if (refused) {
      setErrors(fieldErrors(refused));
      setError(problem(refused, PLACED));
    }
  }

  const fieldProps = (field: string) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? `${id}-${field}-error` : undefined,
  });
  const fieldError = (field: string) =>
    errors[field] ? <FieldError id={`${id}-${field}-error`}>{errors[field]}</FieldError> : null;

  const label = test ? `Edit ${test.code}` : 'Add a test';
  return (
    <form aria-label={label} noValidate onSubmit={(event) => void submit(event)}>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor={`${id}-group`}>Group</FieldLabel>
          <Select value={place} onValueChange={setPlace}>
            <SelectTrigger id={`${id}-group`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {catalogue.groups.flatMap((g) => [
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>,
                ...g.subgroups.map((s) => (
                  <SelectItem key={s.id} value={`${g.id}:${s.id}`}>
                    {testGroupPath(g.name, s.name)}
                  </SelectItem>
                )),
              ])}
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={errors.code ? true : undefined}>
          <FieldLabel htmlFor={`${id}-code`}>Code</FieldLabel>
          <Input
            id={`${id}-code`}
            className="font-mono"
            value={code}
            maxLength={40}
            onChange={(e) => setCode(e.target.value)}
            {...fieldProps('code')}
          />
          {fieldError('code')}
          <FieldDescription>Exactly as in the source, e.g. LAB_MAT-01</FieldDescription>
        </Field>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={`${id}-name`}>Short name (optional)</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            {...fieldProps('name')}
          />
          {fieldError('name')}
          <FieldDescription>Shown in pickers; the full description is kept too.</FieldDescription>
        </Field>
        <Field data-invalid={errors.description ? true : undefined}>
          <FieldLabel htmlFor={`${id}-description`}>Full description</FieldLabel>
          <Textarea
            id={`${id}-description`}
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            {...fieldProps('description')}
          />
          {fieldError('description')}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-tag`}>Sample ID tag</FieldLabel>
          <Select value={tagMode} onValueChange={(value) => setTagMode(value as SampleTagMode)}>
            <SelectTrigger id={`${id}-tag`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SAMPLE_TAG_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {TAG_MODE_CHOICE[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            No tag: e.g. moisture content. Shared: one tag for every test of the group on the same
            sample and depth.
          </FieldDescription>
        </Field>
        {tagMode === 'shared' ? (
          <Field data-invalid={errors.sampleTagGroup ? true : undefined}>
            <FieldLabel htmlFor={`${id}-tag-group`}>Tag group</FieldLabel>
            <Input
              id={`${id}-tag-group`}
              value={tagGroup}
              maxLength={60}
              list={`${id}-tag-groups`}
              onChange={(e) => setTagGroup(e.target.value)}
              {...fieldProps('sampleTagGroup')}
            />
            <datalist id={`${id}-tag-groups`}>
              {tagGroups.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
            {fieldError('sampleTagGroup')}
            <FieldDescription>e.g. Grain size. Same name, same tag.</FieldDescription>
          </Field>
        ) : null}
        {error ? <ProblemAlert>{error}</ProblemAlert> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || missing}>
            {test ? 'Save test' : 'Add test'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
