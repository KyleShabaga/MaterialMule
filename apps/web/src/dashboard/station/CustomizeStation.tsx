import type { StationConfig, StationRow } from '@materialmule/shared';
import { ChevronDown, ChevronUp, GripVertical, Lock, SlidersHorizontal } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { saveStationConfig } from './api';
import { CONFLICT_MESSAGE, lockLine, SAVE_FAILED_MESSAGE, STATION_ROW_INFO } from './rows';

// STRATA-21: "Customize this station". One switch per row and its place in the order. Only a
// Lab Manager with their own account may change it (Kyle, 2026-11-12; STRATA-36 (d): they sign in
// with their own account on the station computer). The LAB session itself sees it read-only,
// with who set it up. Order uses Move up / Move down buttons and Alt+Arrow keys (no drag library).

export interface CustomizeStationProps {
  config: StationConfig;
  /** True only for a Lab Manager's own account (never the LAB session). */
  editable: boolean;
  /** A saved or reloaded config: the caller shows it from now on. */
  onChange?(config: StationConfig): void;
  /** Reads the config again after a 409 (someone saved in between); null when that failed. */
  reload?(): Promise<StationConfig | null>;
}

/** The outline "Customize this station" button and its popover. */
export function CustomizeStation(props: CustomizeStationProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <SlidersHorizontal aria-hidden="true" />
          Customize this station
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" aria-label="Customize this station">
        <StationRowsEditor {...props} />
      </PopoverContent>
    </Popover>
  );
}

type Message = { tone: 'info' | 'error'; text: string } | null;

/** The popover's body; editable or read-only. Exported for tests and the setup card. */
export function StationRowsEditor({ config, editable, onChange, reload }: CustomizeStationProps) {
  const headingId = useId();
  const [pending, setPending] = useState<StationConfig['rows'] | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const rows = pending ?? config.rows;
  const busy = pending !== null;

  async function save(next: StationConfig['rows']) {
    if (!editable || busy) return;
    setPending(next);
    setMessage(null);
    const result = await saveStationConfig(config.stationId, next, config.version);
    if (result.state === 'saved') {
      onChange?.(result.config);
      setMessage({ tone: 'info', text: 'Saved.' });
    } else if (result.state === 'conflict') {
      const fresh = reload ? await reload() : null;
      if (fresh) onChange?.(fresh);
      setMessage({ tone: 'error', text: CONFLICT_MESSAGE });
    } else {
      setMessage({ tone: 'error', text: SAVE_FAILED_MESSAGE });
    }
    setPending(null);
  }

  function toggle(row: StationRow, visible: boolean) {
    void save(rows.map((entry) => (entry.row === row ? { ...entry, visible } : entry)));
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    void save(next);
  }

  function onRowKey(event: KeyboardEvent<HTMLLIElement>, index: number) {
    if (!editable || !event.altKey) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="grid gap-1">
        <h3 id={headingId} className="text-sm font-semibold">
          Shown on this station
        </h3>
        {editable ? (
          <p className="text-[13px] text-muted-foreground">
            Turn rows on or off. Move them up or down (or Alt and an arrow key) to set the order.
          </p>
        ) : null}
      </div>
      <ul className="flex flex-col" aria-label="Rows on this station" aria-busy={busy || undefined}>
        {rows.map((entry, index) => (
          <RowSetting
            key={entry.row}
            row={entry.row}
            visible={entry.visible}
            editable={editable}
            disabled={!editable || busy}
            first={index === 0}
            last={index === rows.length - 1}
            onToggle={(visible) => toggle(entry.row, visible)}
            onMove={(delta) => move(index, delta)}
            onKeyDown={(event) => onRowKey(event, index)}
          />
        ))}
      </ul>
      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'text-[13px] text-destructive-text'
              : 'text-[13px] text-muted-foreground'
          }
        >
          {message.text}
        </p>
      ) : null}
      <div className="grid gap-1.5 border-t pt-3 text-[13px] text-muted-foreground">
        <p>Saved on this computer only.</p>
        {editable ? null : (
          <p className="flex items-start gap-1.5">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{lockLine(config)}</span>
          </p>
        )}
      </div>
    </section>
  );
}

function RowSetting({
  row,
  visible,
  editable,
  disabled,
  first,
  last,
  onToggle,
  onMove,
  onKeyDown,
}: {
  row: StationRow;
  visible: boolean;
  editable: boolean;
  disabled: boolean;
  first: boolean;
  last: boolean;
  onToggle(visible: boolean): void;
  onMove(delta: -1 | 1): void;
  onKeyDown(event: KeyboardEvent<HTMLLIElement>): void;
}) {
  const id = useId();
  const { title } = STATION_ROW_INFO[row];
  return (
    <li className="flex h-10 items-center gap-2" onKeyDown={onKeyDown}>
      <GripVertical aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <label htmlFor={id} className="flex-1 text-sm">
        {title}
      </label>
      {editable ? (
        <span className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${title} up`}
            disabled={disabled || first}
            onClick={() => onMove(-1)}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${title} down`}
            disabled={disabled || last}
            onClick={() => onMove(1)}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </span>
      ) : null}
      <Switch id={id} checked={visible} disabled={disabled} onCheckedChange={onToggle} />
    </li>
  );
}
