import type { SampleTag, SampleTagSheet } from '@materialmule/shared';
import { testNames } from './fit-text';

// The printed 4 × 2 in sample ID card (MM-T69). Black on white in every theme; its layout and
// sizes are the print contract (sample-tags.css), so they change only with the card sheet.

/** One 4 × 2 in card, laid out like the lab's paper tags. */
export function TagCard({
  tag,
  sheet,
  date,
  overflow,
}: {
  tag: SampleTag;
  sheet: SampleTagSheet;
  date: string;
  overflow: boolean;
}) {
  const field = (label: string, value: string, wide = false, name?: string) => (
    <div className={wide ? 'tag-field tag-field-wide' : 'tag-field'}>
      <span className="tag-field-label">{label}</span>
      <span className="tag-value" data-field={name}>
        {value}
      </span>
    </div>
  );
  return (
    <div
      className={overflow ? 'tag-card tag-card-overflow' : 'tag-card'}
      data-tag-key={tag.key}
      aria-label={`Tag ${tag.sampleLabel} at ${tag.depth}, ${tag.source.label}: ${testNames(tag)}`}
    >
      <div className="tag-field">
        <span className="tag-title">Sample Identification</span>
      </div>
      {field('Pan #', '')}
      {field('Date:', date)}
      {field('Sample No.:', tag.sampleLabel, false, 'sample')}
      {field('Project:', sheet.program.project.name, true, 'project')}
      {field('Project No.:', sheet.program.project.projectNumber, false, 'projectNumber')}
      {field('Series No.:', '')}
      {field('Location:', tag.source.label, true, 'location')}
      {field('USC Symbol:', '')}
      {field('Depth:', tag.depth, false, 'depth')}
      <div className="tag-field tag-field-wide tag-field-tests">
        <span className="tag-field-label">Test Required:</span>
        <span className="tag-value tag-value-tests" data-field="tests">
          {testNames(tag)}
        </span>
      </div>
      <span className="tag-ref">
        {sheet.program.programNumber} · L{tag.lineNumbers.join(', L')}
      </span>
    </div>
  );
}
