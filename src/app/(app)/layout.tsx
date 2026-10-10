import type { ReactNode } from 'react';
import { after } from 'next/server';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { prisma } from '@/lib/prisma';
import { NAV_GROUPS, isMenuShown } from '@/lib/nav';
import { getMyDay, SELF_CHECK_IN } from '@/lib/hr/self-attendance';
import { countUnread } from '@/lib/notifications/service';
import { vapidPublicKey } from '@/lib/notifications/push';
import { getWorkshopPreferences } from '@/lib/organization/settings';
import { getBrand } from '@/lib/brand/brand';
import { SidebarNav } from '@/components/shell/sidebar-nav';
import { BottomNav } from '@/components/shell/bottom-nav';
import { Topbar } from '@/components/shell/topbar';
import { SessionGuard } from '@/components/shell/session-guard';
import { RowLinks } from '@/components/shell/row-links';
import { PageContainer } from '@/components/layout/primitives';
import { DeadlineBar } from '@/components/compliance/deadline-bar';
import { DeadlineAlert } from '@/components/compliance/deadline-alert';
import { maybeRunComplianceReminders, urgentDeadlines } from '@/lib/compliance/reminders';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  // Tax and accounting reminders go out once the page is sent — at most every
  // few hours per workshop — so they arrive even with no scheduler set up.
  after(() => maybeRunComplianceReminders(user.organizationId));
  const keepsBooks = hasPermission(user, 'accounting.view');
  const [branch, preferences, brand, myDay, unread, urgent] = await Promise.all([
    user.primaryBranchId
      ? prisma.branch.findUnique({
          where: { id: user.primaryBranchId },
          select: { name: true },
        })
      : null,
    getWorkshopPreferences(user.organizationId),
    getBrand(user.organizationId),
    // The employee's day: drives the check-in pill and its reminders in the top bar.
    getMyDay(user),
    countUnread(user),
    // Late or soon-due deadlines, for the bar above every page.
    keepsBooks ? urgentDeadlines(user.organizationId).catch(() => []) : [],
  ]);
  const employee = myDay?.employee ?? null;
  const attendance = SELF_CHECK_IN && myDay
    ? {
        date: myDay.date,
        firstName: myDay.employee.firstName,
        next: myDay.next,
        recordId: myDay.record?.id ?? null,
        clockInAt: myDay.record?.clockInAt ?? null,
        away: !!myDay.record && ['ABSENT', 'ON_LEAVE', 'HOLIDAY'].includes(myDay.record.status),
        fenceSet: myDay.fence !== null,
        shiftEndTime: myDay.shiftEndTime,
        openEarlier: myDay.openEarlier
          ? { id: myDay.openEarlier.id, date: myDay.openEarlier.date, clockInAt: myDay.openEarlier.clockInAt }
          : null,
      }
    : null;
  // Navigation shows only what the user's permissions allow and the workshop
  // chose to show. Convenience only: every page and action checks
  // permissions again on the server.
  const branchScope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const allowedHrefs = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) =>
      item.forEmployees
        ? employee !== null
        : !item.permission || hasPermission(user, item.permission, branchScope),
    )
    .filter((item) => isMenuShown(item.href, preferences))
    .map((item) => item.href);

  return (
    <div className="flex min-h-screen bg-background">
      <SessionGuard />
      <RowLinks />
      <SidebarNav allowedHrefs={allowedHrefs} brand={brand} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={{ fullName: user.fullName, email: user.email, roleNames: user.roleNames }}
          branchName={branch?.name ?? null}
          brand={brand}
          attendance={attendance}
          notifications={{ unread, vapidKey: vapidPublicKey() }}
        />
        <DeadlineBar items={urgent} />
        <DeadlineAlert items={urgent} />
        <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
          <PageContainer>{children}</PageContainer>
        </main>
        <BottomNav allowedHrefs={allowedHrefs} brand={brand} />
      </div>
    </div>
  );
}
