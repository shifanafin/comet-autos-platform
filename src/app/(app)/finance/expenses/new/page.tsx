import Link from 'next/link';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getExpenseFormOptions } from '@/lib/finance/expenses';
import { PageHeader, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { ScanExpense } from '@/components/finance/scan-expense';

export const metadata = { title: 'Record an expense' };

/**
 * Recording expenses: type them, or scan the supplier's bill. "Save" keeps
 * the form open for the next one; "Save & close" goes back to the list.
 */
export default async function NewExpensePage() {
  const user = await requireUser();
  if (!hasPermission(user, 'expense.create')) return <AccessDenied what="recording expenses" />;
  const options = await getExpenseFormOptions(user);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/expenses" className="text-primary hover:underline">
            Expenses & bills
          </Link>
        }
        title="Record an expense"
        description="Rent, utilities, supplies — anything not bought for a specific job. Outside work for a job is paid on a payment voucher."
      />
      <ScanExpense
        categories={options.categories}
        defaultVatRate={options.defaultVatRate}
        taxCodes={options.taxCodes}
        modes={options.modes}
        people={options.people}
        jobs={options.jobs}
        moneyAccounts={options.moneyAccounts}
        closeTo="/finance/expenses"
      />
    </Stack>
  );
}
