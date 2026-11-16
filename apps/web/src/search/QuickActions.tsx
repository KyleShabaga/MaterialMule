import { ArrowDownToLine, ChevronDown, FolderPlus, ScanLine, Zap } from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '../session/context';
import { useCommandMenu } from './command-menu';
import {
  commandShortcutLabel,
  NEW_PROJECT_PATH,
  quickActionItems,
  RECEIVE_PATH,
} from './menu-items';

// Motion (DESIGN.md › Shell › Quick actions), plain CSS: the trigger keeps a fixed 44 px box and
// the 194 px filled pill is a layer over it, revealed leftward with clip-path while the bolt
// slides with a transform, so nothing else in the top bar re-lays out. Hover waits 100 ms;
// keyboard focus and an open menu skip the wait. 250 ms cubic-bezier(0.77, 0, 0.175, 1) in, the
// label and chevron fade in from 200 ms; leaving closes at once and faster (200 ms, text 100 ms).
// No transitions under prefers-reduced-motion.
const EASE = 'ease-[cubic-bezier(0.77,0,0.175,1)]';
const PILL = [
  'pointer-events-none absolute top-[-1px] right-[-1px] flex h-[calc(100%+2px)] w-[194px] items-center rounded-md bg-primary text-primary-foreground opacity-0',
  '[clip-path:inset(0_0_0_calc(100%-44px)_round_8px)]',
  `transition-[clip-path,opacity] duration-200 ${EASE} delay-0 motion-reduce:transition-none`,
  'group-hover:opacity-100 group-hover:delay-100 group-hover:duration-250 group-hover:[clip-path:inset(0_round_8px)]',
  'group-focus-visible:opacity-100 group-focus-visible:delay-0 group-focus-visible:[clip-path:inset(0_round_8px)]',
  'group-data-[state=open]:opacity-100 group-data-[state=open]:delay-0 group-data-[state=open]:[clip-path:inset(0_round_8px)]',
].join(' ');
const BOLT = [
  'flex h-full w-[42px] shrink-0 translate-x-[150px] items-center justify-center',
  `transition-transform duration-200 ${EASE} delay-0 motion-reduce:transition-none`,
  'group-hover:translate-x-0 group-hover:delay-100 group-hover:duration-250',
  'group-focus-visible:translate-x-0 group-focus-visible:delay-0',
  'group-data-[state=open]:translate-x-0 group-data-[state=open]:delay-0',
].join(' ');
const LABEL = [
  'flex items-center opacity-0 transition-opacity duration-100 ease-out delay-0 motion-reduce:transition-none',
  'group-hover:opacity-100 group-hover:duration-200 group-hover:delay-200',
  'group-focus-visible:opacity-100 group-focus-visible:delay-100',
  'group-data-[state=open]:opacity-100 group-data-[state=open]:delay-0',
].join(' ');

/**
 * Top-bar Quick actions (STRATA-12, 45): 44 px zap trigger that widens into "Quick actions";
 * menu Scan (opens the command menu), Receive, New project. The shell renders it left of the bell.
 */
export function QuickActions() {
  const menu = useCommandMenu();
  const { session } = useSession();
  const permissions = session.status === 'active' ? session.me.permissions : [];
  const items = quickActionItems(permissions);
  /** Scan was chosen: the dropdown must not pull focus back to its trigger as it closes. */
  const scanning = useRef(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Quick actions"
          className="group relative data-[state=open]:bg-background"
        >
          <Zap className="size-5" />
          <span aria-hidden="true" className={PILL}>
            <span className={BOLT}>
              <Zap className="size-5" />
            </span>
            <span className={LABEL}>
              <span className="text-sm font-medium whitespace-nowrap">Quick actions</span>
              <span className="ml-3 flex h-6 items-center border-l border-primary-foreground/30 px-2.5">
                <ChevronDown className="transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
              </span>
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-56"
        onCloseAutoFocus={(event) => {
          if (!scanning.current) return;
          scanning.current = false;
          event.preventDefault();
          menu.open();
        }}
      >
        <DropdownMenuItem onSelect={() => (scanning.current = true)}>
          <ScanLine />
          Scan
          <DropdownMenuShortcut>{commandShortcutLabel()}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {items.receive ? (
          <DropdownMenuItem asChild>
            <Link to={RECEIVE_PATH}>
              <ArrowDownToLine />
              Receive
            </Link>
          </DropdownMenuItem>
        ) : null}
        {items.newProject ? (
          <DropdownMenuItem asChild>
            <Link to={NEW_PROJECT_PATH}>
              <FolderPlus />
              New project
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
