import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { getOwedToOwners, type OwedToOwners } from '@/lib/finance/owner-payments';
import { listAttachments } from '@/lib/documents/attachments';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { formatMoney, localDateString } from '@/lib/format';
import { PageHeader, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { OwedToOwnersPanel } from '@/components/finance/owed-to-owners';

export const dynamic = 'force-dynamic';

const asFiles = (map: Map<string, { id: string; fileName: string }[]>) =>
  Object.fromEntries(
    [...map].map(([id, rows]) => [id, rows.map((row) => ({ id: row.id, fileName: row.fileName }))]),
  );

/*
 * Owed to owner: bills the owner paid with his own card or cash, booked to
 * 2520 "Due to owner (current account)", and what the workshop has paid him
 * back. Account 2520's balance is the total owed; this page shows it line by
 * line, per owner.
 */
export default async function OwedToOwnerPage() {
  const user = await requireUser();
  let data: OwedToOwners;
  try {
    data = await getOwedToOwners(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="what the workshop owes its owner" />;
    throw error;
  }
  const canReimburse = hasPermission(user, 'accounting.create');
  const idsOf = (kind: 'expense' | 'repayment') =>
    data.people.flatMap((person) =>
      person.lines.filter((line) => line.kind === kind).map((line) => line.id),
    );
  const [files, billFiles, modes] = await Promise.all([
    listAttachments(user, 'OwnerReimbursement', idsOf('repayment')),
    hasPermission(user, 'expense.view')
      ? listAttachments(user, 'Expense', idsOf('expense'))
      : Promise.resolve(new Map()),
    canReimburse ? getPaymentModeOptions(user.organizationId, 'reimburse') : Promise.resolve([]),
  ]);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Cash & Bank"
        title="Owed to owner"
        description={`Bills the owner paid personally, and what has been paid back. ${formatMoney(data.total)} owed now.`}
      />
      <OwedToOwnersPanel
        data={data}
        files={asFiles(files)}
        billFiles={asFiles(billFiles)}
        modes={modes}
        today={localDateString()}
        canReimburse={canReimburse}
        canReverse={hasPermission(user, 'accounting.delete')}
        canRemoveFile={hasPermission(user, 'accounting.edit')}
      />
    </Stack>
  );
}
