import {
  ArrowDownToLine,
  ChevronRight,
  Compass,
  Cylinder,
  FlaskConical,
  KeyRound,
  MessageCircleQuestionMark,
  Package,
  Search,
  SearchX,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { commandShortcutLabel } from '../search/menu-items';
import {
  HELP_QUESTIONS,
  groupById,
  helpShortcuts,
  searchGuides,
  type HelpGroup,
  type HelpGuide,
  type HelpShortcut,
} from './guides';

// The pieces the Help drawer and the /help page share (STRATA-103, round 10).

const GROUP_ICONS: Record<HelpGroup['icon'], LucideIcon> = {
  compass: Compass,
  'arrow-down-to-line': ArrowDownToLine,
  package: Package,
  'flask-conical': FlaskConical,
  cylinder: Cylinder,
  'key-round': KeyRound,
};

export function GroupIcon({ group, className }: { group: HelpGroup; className?: string }) {
  const Icon = GROUP_ICONS[group.icon];
  return <Icon aria-hidden="true" className={className} />;
}

/** "Ctrl K" and "Ctrl B" in a guide's words show as keys; on a Mac they read ⌘. */
export function HelpText({ text }: { text: string }) {
  const parts = text.split(/(Ctrl [A-Z])/);
  const mod = commandShortcutLabel().replace(/\s*K$/, '');
  return (
    <>
      {parts.map((part, index) =>
        /^Ctrl [A-Z]$/.test(part) ? (
          <Kbd key={index}>{`${mod} ${part.slice(-1)}`}</Kbd>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** A guide's answer: its paragraph, numbered steps and note, or the open-item marker. */
export function GuideAnswer({ guide }: { guide: HelpGuide }) {
  return (
    <div className="flex flex-col gap-2 text-muted-foreground">
      {guide.openItem ? (
        <p className="flex items-center gap-2">
          <Badge variant="outline" className="border-dashed">
            Open item
          </Badge>
          <span>
            <HelpText text={guide.body ?? ''} />
          </span>
        </p>
      ) : guide.body ? (
        <p>
          <HelpText text={guide.body} />
        </p>
      ) : null}
      {guide.steps ? (
        <ol className="flex list-decimal flex-col gap-1.5 pl-5">
          {guide.steps.map((step) => (
            <li key={step}>
              <HelpText text={step} />
            </li>
          ))}
        </ol>
      ) : null}
      {guide.note ? (
        <p>
          <HelpText text={guide.note} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * Guides as an accordion. `anchors` gives each item its stable `id` (the /help page), so
 * `/help#<guide>` lands on it.
 */
export function GuideAccordion({
  guides,
  value,
  onValueChange,
  defaultValue,
  anchors = false,
  className,
}: {
  guides: HelpGuide[];
  value?: string[];
  onValueChange?: (value: string[]) => void;
  defaultValue?: string[];
  anchors?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border bg-card px-4', className)}>
      <Accordion
        type="multiple"
        value={value}
        onValueChange={onValueChange}
        defaultValue={defaultValue}
      >
        {guides.map((guide, index) => (
          <AccordionItem
            key={guide.id}
            value={guide.id}
            id={anchors ? guide.id : undefined}
            className={cn('scroll-mt-20', index === guides.length - 1 && 'border-b-0')}
          >
            <AccordionTrigger>{guide.title}</AccordionTrigger>
            <AccordionContent>
              <GuideAnswer guide={guide} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

/** Common questions (round 10: "Does an ID ever change?", "Does it work from home?"). */
export function CommonQuestions({ headingId }: { headingId: string }) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-[13px] font-medium text-muted-foreground">
        Common questions
      </h3>
      <div className="rounded-xl border bg-card px-4">
        <Accordion type="single" collapsible>
          {HELP_QUESTIONS.map((question, index) => (
            <AccordionItem
              key={question.id}
              value={question.id}
              className={cn(index === HELP_QUESTIONS.length - 1 && 'border-b-0')}
            >
              <AccordionTrigger>{question.q}</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{question.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

function ShortcutKeys({ shortcut }: { shortcut: HelpShortcut }) {
  return (
    <dd className="flex items-center gap-1">
      {shortcut.keys.map((key, index) => (
        <Fragment key={key}>
          {index > 0 && shortcut.joiner === 'or' ? (
            <span className="px-1 text-[13px] text-muted-foreground">or</span>
          ) : null}
          <Kbd>{key}</Kbd>
        </Fragment>
      ))}
    </dd>
  );
}

function ShortcutTable({
  id,
  title,
  rows,
  extra,
}: {
  id: string;
  title: string;
  rows: HelpShortcut[];
  extra?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-[13px] font-medium text-muted-foreground">
        {title}
      </h3>
      <dl className="divide-y rounded-xl border bg-card text-sm">
        {rows.map((row) => (
          <div key={row.what} className="flex items-center gap-3 px-4 py-2.5">
            <dt className="flex-1">{row.what}</dt>
            <ShortcutKeys shortcut={row} />
          </div>
        ))}
        {extra}
      </dl>
    </section>
  );
}

/** Keyboard shortcuts (round 10: Ctrl K, Ctrl B, ?, J/K, Esc). */
export function ShortcutsList({ idPrefix }: { idPrefix: string }) {
  const mod = commandShortcutLabel().replace(/\s*K$/, '');
  const { anywhere, lists } = helpShortcuts(mod);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        On a computer with a keyboard. They never fire while you type in a field.
      </p>
      <ShortcutTable id={`${idPrefix}-anywhere`} title="Anywhere" rows={anywhere} />
      <ShortcutTable
        id={`${idPrefix}-lists`}
        title="In lists and drawers"
        rows={lists}
        extra={
          <div className="flex items-center gap-3 px-4 py-2.5">
            <dt className="flex-1">Scan a label with no field selected</dt>
            <dd className="text-[13px] text-muted-foreground">Just scan</dd>
          </div>
        }
      />
    </div>
  );
}

/** "Search help": Escape clears the words, then (empty) lets the caller close. */
export function HelpSearchField({
  value,
  onChange,
  onEscapeEmpty,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscapeEmpty?: () => void;
  className?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (value) onChange('');
    else onEscapeEmpty?.();
  }
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder="Search help"
        aria-label="Search help"
        value={value}
        maxLength={100}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange('')}>
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent px-0.5 text-accent-foreground">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}

/** One line from a guide for its search result: the paragraph or the first step. */
function guideSummary(guide: HelpGuide): string {
  return guide.body ?? guide.steps?.[0] ?? '';
}

/**
 * Search results ("3 guides match “label”") or the no-match state. `onAsk` (signed in only)
 * offers Ask a question, which opens Feedback & bugs on Question.
 */
export function HelpSearchResults({
  query,
  headingId,
  onOpenGuide,
  onAsk,
}: {
  query: string;
  headingId: string;
  onOpenGuide: (guide: HelpGuide) => void;
  onAsk?: () => void;
}) {
  const q = query.trim();
  const results = searchGuides(q);
  if (results.length === 0) {
    return (
      <Empty role="status" className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="text-sm font-semibold">No guide matches “{q}”.</EmptyTitle>
          <EmptyDescription>Try another word, or ask the administrator.</EmptyDescription>
        </EmptyHeader>
        {onAsk ? (
          <EmptyContent>
            <Button variant="outline" onClick={onAsk}>
              <MessageCircleQuestionMark aria-hidden="true" />
              Ask a question
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} role="status" className="text-[13px] font-medium text-muted-foreground">
        {results.length === 1 ? '1 guide matches' : `${results.length} guides match`} “{q}”
      </h3>
      <ItemGroup className="divide-y rounded-xl border bg-card">
        {results.map((guide) => (
          <div role="listitem" key={guide.id}>
            <Item size="sm" asChild>
              <button
                type="button"
                className="w-full text-left hover:bg-accent/50"
                onClick={() => onOpenGuide(guide)}
              >
                <ItemContent className="min-w-0">
                  <span className="text-[13px] text-muted-foreground">
                    {groupById(guide.group)?.label}
                  </span>
                  <ItemTitle>
                    <span>
                      <Highlight text={guide.title} query={q} />
                    </span>
                  </ItemTitle>
                  <ItemDescription>{guideSummary(guide)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                </ItemActions>
              </button>
            </Item>
          </div>
        ))}
      </ItemGroup>
    </section>
  );
}
