import Link from 'next/link';
import { ChevronDown, KeyRound, LogOut, MapPin, UserRound } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GlobalSearch } from '@/components/shell/global-search';
import { InstallAppButton } from '@/components/shell/install-app';
import { CONTAINER_X } from '@/components/layout/primitives';
import { cn } from '@/lib/utils';
import { logout } from '@/lib/auth/logout-action';
import type { Brand } from '@/lib/brand/brand';

function initials(fullName: string): string {
  return fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

/** Top bar: search, branch, and who is signed in — with their account menu. */
export function Topbar({
  user,
  branchName,
  brand,
}: {
  user: { fullName: string; email: string; roleNames: string[] };
  branchName: string | null;
  brand: Pick<Brand, 'shortName' | 'initial'>;
}) {
  const role = user.roleNames.join(' / ') || 'Staff';
  return (
    <header className="sticky top-0 z-30 h-[calc(4rem+env(safe-area-inset-top))] shrink-0 border-b pt-[env(safe-area-inset-top)] border-border/70 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className={cn(CONTAINER_X, 'flex h-full items-center gap-4')}>
        {/* Navigation on phones lives in the bottom bar; the mark here only says where you are. */}
        <Link
          href="/"
          aria-label={`${brand.shortName} dashboard`}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground md:hidden"
        >
          {brand.initial}
        </Link>
        <div className="min-w-0 flex-1">
          <GlobalSearch />
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
          {branchName ? (
            <span className="hidden items-center gap-2 text-sm text-muted-foreground xl:flex">
              <MapPin className="size-4" />
              {branchName}
            </span>
          ) : null}
          {branchName ? <span className="hidden h-6 w-px bg-border xl:block" aria-hidden /> : null}

          <InstallAppButton appName={brand.shortName} />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Account menu for ${user.fullName}`}
              className="flex h-11 items-center gap-2.5 rounded-full py-1 pr-2 pl-1 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:pr-3"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-primary bg-gradient-to-br from-violet-400 to-violet-700 text-xs font-semibold text-primary-foreground shadow-glow">
                {initials(user.fullName)}
              </span>
              <span className="hidden min-w-0 flex-col items-start leading-tight sm:flex">
                <span className="max-w-44 truncate text-sm font-medium">{user.fullName}</span>
                <span className="max-w-44 truncate text-xs text-muted-foreground">{role}</span>
              </span>
              <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="py-2">
                  <span className="block truncate font-medium text-foreground">
                    {user.fullName}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                  <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                    {role}
                  </span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/account" />} className="h-10 gap-2.5">
                <UserRound />
                My profile
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/account#password" />} className="h-10 gap-2.5">
                <KeyRound />
                Change password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <form action={logout}>
                <DropdownMenuItem
                  render={<button type="submit" className="w-full" />}
                  variant="destructive"
                  className="h-10 gap-2.5"
                >
                  <LogOut />
                  Log out
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
