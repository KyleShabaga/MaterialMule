import { initialsFromName, personPhotoUrl } from '@materialmule/shared';
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
 * Initials for an avatar fallback: the shared `initialsFromName`, after dropping parenthesised
 * notes such as "(LAB)" (which would otherwise give "P(" for "Pat Example (LAB)").
 */
// eslint-disable-next-line react-refresh/only-export-components -- tiny pure helper beside its component
export function initialsFor(name: string | null | undefined): string {
  return initialsFromName((name ?? '').replace(/\([^)]*\)/g, ' '));
}

export interface PersonAvatarProps {
  name?: string | null;
  /**
   * The person's user ID: loads their cached directory photo (`personPhotoUrl`, a 404 falls back
   * to initials). Ignored when `photoUrl` is given.
   */
  userId?: string | null;
  /** An explicit photo URL; overrides `userId`. */
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
  userId,
  photoUrl,
  size = 'default',
  system = false,
  className,
}: PersonAvatarProps) {
  const src = photoUrl ?? (userId ? personPhotoUrl(userId) : null);
  return (
    <Avatar aria-hidden="true" data-person-size={size} className={cn(SIZE_CLASS[size], className)}>
      {src && !system ? <AvatarImage src={src} alt="" /> : null}
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
