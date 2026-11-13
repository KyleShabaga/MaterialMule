import { UserPlus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { DataTable, type DataTableColumn } from '@/components/strata/data-table';
import {
  PeekSplit,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '@/components/strata/peek';
import { PersonCell } from '@/components/strata/person-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { NEEDS_REVIEW } from './GrantReviewsSection';
import { PersonDrawer } from './PersonDrawer';
import { TeamCard } from './TeamCard';
import {
  AddGrantDialog,
  type GrantApply,
  type GrantKind,
  type GrantTarget,
  type RunWrite,
} from './TeamSections';
import { isoDate } from './team-format';
import {
  grantLabels,
  needsLeadReview,
  responsibilityLabels,
  teamPeople,
  type TeamData,
  type TeamPersonRow,
} from './team-people';

// Team & permissions › People (STRATA-85; boards R4Team, R4TeamPerson, R4Team1024): a DataTable
// of everyone with a responsibility or grant here (person, job title, responsibilities, grants
// as tags). A row opens the person drawer (Inbox's PeekSplit, `?open=<userId>`, from 1024 px; a
// Sheet below that, since a person has no full page). Job titles and team places grant no
// approvals; the note says so once, near the table.

function Tags({ labels, empty = 'None' }: { labels: string[]; empty?: string }): ReactNode {
  if (labels.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="secondary" className="max-w-full truncate">
          {label}
        </Badge>
      ))}
    </span>
  );
}

const COLUMNS: DataTableColumn<TeamPersonRow & { meId: string }>[] = [
  {
    id: 'person',
    header: 'Person',
    priority: 'identity',
    cell: (row) => (
      <PersonCell
        name={row.userId === row.meId ? `${row.name} (you)` : row.name}
        userId={row.userId}
      />
    ),
  },
  {
    id: 'jobTitle',
    header: 'Job title',
    priority: 'attribute',
    width: '12rem',
    hideOrder: 1,
    cell: (row) =>
      row.jobTitle ? (
        <span title={row.jobTitle.value}>{row.jobTitle.value}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'responsibilities',
    header: 'Responsibilities',
    priority: 'attribute',
    width: '15rem',
    hideOrder: 3,
    wrap: true,
    cell: (row) => {
      const labels = responsibilityLabels(row);
      return labels.length ? (
        <span>{labels.join(' · ')}</span>
      ) : (
        <span className="text-muted-foreground">None</span>
      );
    },
  },
  {
    id: 'grants',
    header: 'Grants',
    priority: 'attribute',
    width: '16rem',
    hideOrder: 2,
    wrap: true,
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <Tags labels={grantLabels(row, isoDate)} />
        {needsLeadReview(row) ? <Badge variant="due">{NEEDS_REVIEW}</Badge> : null}
      </span>
    ),
  },
];

export function TeamPeopleSection({
  data,
  meId,
  run,
  apply,
  historyKey,
}: {
  data: TeamData;
  meId: string;
  run: RunWrite;
  apply: GrantApply;
  historyKey: number;
}) {
  const people = useMemo(() => teamPeople(data).map((row) => ({ ...row, meId })), [data, meId]);
  const peek = usePeekParam();
  const wide = usePeekAvailable();
  const [adding, setAdding] = useState<{ kind: GrantKind; target: GrantTarget | null } | null>(
    null,
  );
  const open = people.find((p) => p.userId === peek.openId) ?? null;
  const ids = people.map((p) => p.userId);
  const nav = peekNeighbours(ids, open?.userId ?? null);
  const previous = nav.previousId ? () => peek.open(nav.previousId!) : undefined;
  const next = nav.nextId ? () => peek.open(nav.nextId!) : undefined;
  usePeekKeys({
    enabled: open !== null && wide,
    onClose: peek.close,
    onPrevious: previous,
    onNext: next,
  });

  const addOptions: { kind: GrantKind; label: string }[] = [];
  if (data.team.canManage) addOptions.push({ kind: 'team', label: 'Add to the team…' });
  if (data.reviewers.canManage) addOptions.push({ kind: 'reviewer', label: 'Assign a reviewer…' });
  if (data.issuers.canManage) {
    addOptions.push({ kind: 'issuer', label: 'Authorize a report issuer…' });
  }
  if (data.delegates?.canManage) {
    addOptions.push({ kind: 'delegate', label: 'Add an acceptance delegate…' });
  }

  const table = (
    <DataTable
      columns={COLUMNS}
      data={people}
      getRowId={(row) => row.userId}
      rowLabel={(row) => row.name}
      caption={`People on ${data.project.projectNumber}`}
      empty="Nobody is assigned to this project yet."
      onOpenRow={(row) => peek.open(row.userId)}
      openRowId={open?.userId ?? null}
      freeColumnMin="12rem"
    />
  );

  const drawer = open ? (
    <PersonDrawer
      key={open.userId}
      person={open}
      data={data}
      run={run}
      apply={apply}
      meId={meId}
      historyKey={historyKey}
      position={{ index: nav.index, total: nav.total }}
      onPrevious={previous}
      onNext={next}
      onClose={peek.close}
      onAddGrant={(kind, target) => setAdding({ kind, target })}
    />
  ) : null;

  return (
    <TeamCard
      id="team-people"
      title="People"
      count={people.length}
      action={
        addOptions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <UserPlus aria-hidden="true" />
                Add a person
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {addOptions.map((option) => (
                <DropdownMenuItem
                  key={option.kind}
                  onSelect={() => setAdding({ kind: option.kind, target: null })}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
    >
      <p className="text-[13px] text-muted-foreground">
        Job titles and team places grant no approvals. Only the responsibilities and grants listed
        here count, on this project only.
      </p>
      {wide ? (
        <PeekSplit
          list={table}
          drawer={drawer}
          open={open !== null}
          openId={open?.userId ?? null}
          drawerLabel={open ? open.name : undefined}
          listLabel="People on this project"
          className={open ? 'min-h-[36rem] rounded-lg border' : undefined}
        />
      ) : (
        <>
          {table}
          <Sheet open={open !== null} onOpenChange={(value) => !value && peek.close()}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-full gap-0 p-0 sm:max-w-lg"
            >
              <SheetTitle className="sr-only">{open?.name ?? 'Person'}</SheetTitle>
              <SheetDescription className="sr-only">
                Their responsibilities, grants and history on this project.
              </SheetDescription>
              {drawer}
            </SheetContent>
          </Sheet>
        </>
      )}
      {adding ? (
        <AddGrantDialog
          kind={adding.kind}
          projectId={data.project.id}
          scopes={data.scopes}
          target={adding.target}
          run={run}
          apply={apply}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </TeamCard>
  );
}
