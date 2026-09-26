import type { ReactNode } from 'react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { prisma } from '@/lib/prisma';
import { NAV_GROUPS, isMenuShown } from '@/lib/nav';
import { getWorkshopPreferences } from '@/lib/organization/settings';
import { getBrand } from '@/lib/brand/brand';
import { SidebarNav } from '@/components/shell/sidebar-nav';
import { BottomNav } from '@/components/shell/bottom-nav';
import { Topbar } from '@/components/shell/topbar';
import { SessionGuard } from '@/components/shell/session-guard';
import { PageContainer } from '@/components/layout/primitives';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [branch, preferences, brand] = await Promise.all([
    user.primaryBranchId
      ? prisma.branch.findUnique({
          where: { id: user.primaryBranchId },
          select: { name: true },
        })
      : null,
    getWorkshopPreferences(user.organizationId),
    getBrand(user.organizationId),
  ]);
  // Navigation shows only what the user's permissions allow and the workshop
  // chose to show. Convenience only: every page and action checks
  // permissions again on the server.
  const branchScope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const allowedHrefs = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => !item.permission || hasPermission(user, item.permission, branchScope))
    .filter((item) => isMenuShown(item.href, preferences))
    .map((item) => item.href);

  return (
    <div className="flex min-h-screen bg-background">
      <SessionGuard />
      <SidebarNav allowedHrefs={allowedHrefs} brand={brand} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={{ fullName: user.fullName, email: user.email, roleNames: user.roleNames }}
          branchName={branch?.name ?? null}
          brand={brand}
        />
        <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
          <PageContainer>{children}</PageContainer>
        </main>
        <BottomNav allowedHrefs={allowedHrefs} brand={brand} />
      </div>
    </div>
  );
}
