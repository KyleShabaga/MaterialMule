import { useId, useState } from 'react';
import { BandedCard } from '../../components/ui';

// MM-V2-C30 Summary tab shell: the date range (default All dates) and Generate summary report,
// which stays disabled until the summary report output exists (C32).

export function SummaryTab() {
  const id = useId();
  const [range, setRange] = useState<'all' | 'between'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <BandedCard title="Summary report" className="concrete-tab">
      <fieldset className="concrete-range">
        <legend>Date range</legend>
        <label>
          <input
            type="radio"
            name={`${id}-range`}
            checked={range === 'all'}
            onChange={() => setRange('all')}
          />{' '}
          All dates
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-range`}
            checked={range === 'between'}
            onChange={() => setRange('between')}
          />{' '}
          Between dates
        </label>
        {range === 'between' ? (
          <div className="concrete-range-dates">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        ) : null}
      </fieldset>
      <button type="button" className="primary" disabled aria-describedby={`${id}-later`}>
        Generate summary report
      </button>
      <p id={`${id}-later`} className="field-hint">
        The summary report isn’t available yet. It arrives with the summary report card (C32).
      </p>
    </BandedCard>
  );
}
