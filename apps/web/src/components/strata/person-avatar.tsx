import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export type PersonAvatarSize = 'compact' | 'default' | 'lg';

// DESIGN.md › Components › People in tables: 20 px in compact tables, 24 px in normal ones;
// 32 px for account rows. Literal classes so Tailwind finds them.
const SIZE_CLASS: Record<PersonAvatarSize, string> = {
  compact: 'size-5',
  default: 'size-6',
  lg: 'size-8',
};

/**
 * Initials for an avatar fallback: the first letter of the first and last words, upper case.
 * One word gives one letter; parenthesised notes such as "(LAB)" and extra spaces are ignored;
 * an empty name gives "?".
 */
// eslint-disable-next-line react-refresh/only-export-components -- tiny pure helper beside its component
export function initialsFor(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  // Array.from keeps a letter outside the BMP whole.
  return `${Array.from(first)[0] ?? ''}${last ? (Array.from(last)[0] ?? '') : ''}`.toUpperCase();
}

export interface PersonAvatarProps {
  name?: string | null;
  /** Directory photo URL when there is one (photo storage is lane 1C); initials otherwise. */
  photoUrl?: string | null;
  size?: PersonAvatarSize;
  /** Material Mule itself (system messages): a `primary` avatar reading "MM". */
  system?: boolean;
  className?: string;
}

/**
 * A person's avatar (STRATA-52). Decorative: the name is always written beside it, so it is
 * aria-hidden. The fallback is `muted`, never a stage colour (DESIGN.md › Lifecycle).
 */
export function PersonAvatar({
  name,
  photoUrl,
  size = 'default',
  system = false,
  className,
}: PersonAvatarProps) {
  return (
    <Avatar aria-hidden="true" data-person-size={size} className={cn(SIZE_CLASS[size], className)}>
      {photoUrl && !system ? <AvatarImage src={photoUrl} alt="" /> : null}
      <AvatarFallback
        className={cn(
          'text-[11px] font-semibold',
          system ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {system ? 'MM' : initialsFor(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * A person in a table cell: avatar, then the name truncating beside it with the full name in
 * `title`. A missing name reads "Unknown person".
 */
export function PersonCell({ name, className, ...avatar }: PersonAvatarProps) {
  const shown = avatar.system ? name?.trim() || 'Material Mule' : name?.trim();
  return (
    <span data-slot="person-cell" className={cn('flex min-w-0 items-center gap-2', className)}>
      <PersonAvatar name={shown} {...avatar} />
      {shown ? (
        <span className="min-w-0 truncate" title={shown}>
          {shown}
        </span>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground">Unknown person</span>
      )}
    </span>
  );
}
