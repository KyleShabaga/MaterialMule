import {
  LAB_PROGRAM_PHASE_TAG,
  STAGE_WORDS,
  type LabProgramSummary,
  type ProjectListItem,
  type StageKey,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { START_DELIVERY_PATH } from '../receiving-log/paths';

// Formatting and small hooks for the Strata project screens (STRATA-83, STRATA-84).

/** `value`, settled for `ms` (search fetches wait for typing to pause; the URL doesn't). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export function daysBetween(today: string, date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** DESIGN.md › Dates: "in 7 days", "today", "3 days ago". */
export function relativeDays(today: string, date: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days === 1) return 'in 1 day';
  if (days > 1) return `in ${days} days`;
  if (days === -1) return '1 day ago';
  return `${-days} days ago`;
}

/** A lab program's stage: from its phase (as the list and Workboard), else the server's, else its status. */
export function programStage(program: LabProgramSummary): StageKey {
  if (program.phase) return LAB_PROGRAM_PHASE_TAG[program.phase].stage;
  if (program.stage) return program.stage;
  return program.status === 'draft' ? 'draft' : program.status === 'closed' ? 'closed' : 'lab';
}

/** "Due · Review", "In lab · Testing" … (DESIGN.md › Soils lab: "<Stage> · <domain>"). */
export function programStatusLabel(program: LabProgramSummary): string {
  if (program.phase) return LAB_PROGRAM_PHASE_TAG[program.phase].label;
  return `${STAGE_WORDS[programStage(program)]} · Lab program`;
}

/** Done of counted tests (cancelled tests are counted apart; progress only). */
export function programProgress(program: LabProgramSummary): { done: number; total: number } {
  const { done, inProgress, notStarted } = program.progress;
  return { done, total: done + inProgress + notStarted };
}

/** A program's number, or "Draft lab program" (numbers are issued on submit). */
export function programName(program: LabProgramSummary): string {
  return program.programNumber ?? 'Draft lab program';
}

/** "Alex Tester nominated Morgan Demo · waiting for an admin", or "No nomination". */
export function nominationLine(project: Pick<ProjectListItem, 'leadNomination'>): string {
  const n = project.leadNomination;
  return n
    ? `${n.nominatedByName} nominated ${n.nomineeName} · waiting for an admin`
    : 'No nomination';
}

/** "Receive for this project": a new delivery with the project chosen. */
export function receiveForProjectPath(projectId: string): string {
  return `${START_DELIVERY_PATH}&projectId=${encodeURIComponent(projectId)}`;
}

/** Copies via the Clipboard API, or the older selection copy where that's unavailable (http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection copy.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Storage units tab filtered to one test hole. */
export function holeUnitsPath(projectId: string, holeId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/units?hole=${encodeURIComponent(holeId)}`;
}
