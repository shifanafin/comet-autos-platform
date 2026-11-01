import Link from 'next/link';
import { Plus } from 'lucide-react';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/authorize';
import { prisma } from '@/lib/prisma';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { Panel, Section } from '@/components/layout/primitives';
import { LinkButton } from '@/components/shared/link-button';

/**
 * What the workshop spent on this car beyond its parts — fuel, a wash, towing,
 * outside work. Each is an ordinary expense filed against the job, so it counts
 * in the books and in the job's profit. It isn't billed by itself: charging the
 * customer is an "Other" line on the invoice.
 */
export async function JobCostsSection({
  user,
  jobCardId,
}: {
  user: AuthenticatedUser;
  jobCardId: string;
}) {
  const canSee = hasPermission(user, 'expense.view');
  const canAdd = hasPermission(user, 'expense.create');
  if (!canSee && !canAdd) return null;
  const expenses = canSee
    ? await prisma.expense.findMany({
        where: {
          organizationId: user.organizationId,
          status: 'RECORDED',
          OR: [{ jobCardId }, { invoice: { jobCardId } }],
        },
        orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          description: true,
          vendorName: true,
          amount: true,
          expenseDate: true,
        },
      })
    : [];

  return (
    <Section
      title="Costs on this car"
      description="Fuel, wash, towing, outside work: what it cost you. To charge the customer, add an Other line on the invoice. That is income against this cost, not a duplicate."
      action={
        canAdd ? (
          <LinkButton
            href={`/finance/expenses/new?job=${encodeURIComponent(`card:${jobCardId}`)}`}
            variant="outline"
          >
            <Plus />
            Add cost
          </LinkButton>
        ) : null
      }
    >
      {expenses.length ? (
        <Panel padding="none">
          <ul className="divide-y divide-border text-sm">
            {expenses.map((expense) => (
              <li key={expense.id}>
                <Link
                  href={`/finance/expenses/${expense.id}`}
                  className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{expense.description}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[expense.vendorName, formatCalendarDate(expense.expenseDate)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMoney(expense.amount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing recorded for this car yet.</p>
      )}
    </Section>
  );
}
