import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getEntryForEdit } from '@/lib/accounting/entries';
import { getAccountChoices, sourceLinks } from '@/lib/accounting/reports';
import { formatCalendarDate, localDateString } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { JournalEntryForm } from '@/components/accounting/journal-entry-form';
import { JournalNarrationForm } from '@/components/accounting/journal-narration-form';
import { DeleteEntryButton } from '@/components/accounting/books-controls';

export const metadata = { title: 'Edit journal entry' };

/**
 * One journal entry, opened for correction. An entry made by hand in an
 * open period can be changed in full or deleted; any other entry — one
 * booked from a record, or in a closed period — has its narration
 * corrected here and its figures through its record (or a reversal).
 */
export default async function EditJournalEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.edit')) return <AccessDenied what="the accounts" />;
  const { id } = await params;
  let data;
  try {
    data = await getEntryForEdit(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="the accounts" />;
    throw error;
  }
  const { entry, figuresLocked, deletable } = data;
  const number = entry.entryNumber ?? 'Entry';
  const source = (await sourceLinks(user.organizationId, [entry]))(
    entry.sourceType,
    entry.sourceId,
  );
  const canDelete = deletable && hasPermission(user, 'accounting.delete');

  let form;
  if (figuresLocked) {
    form = (
      <JournalNarrationForm
        entryId={entry.id}
        description={entry.description ?? ''}
        lines={entry.lines.map((line) => ({
          id: line.id,
          account: `${line.chartOfAccount.accountCode} · ${line.chartOfAccount.accountName}`,
          party: line.customer
            ? `Customer: ${line.customer.name}`
            : line.supplier
              ? `Supplier: ${line.supplier.name}`
              : null,
          debit: line.debitAmount.toString(),
          credit: line.creditAmount.toString(),
          memo: line.description ?? '',
        }))}
      />
    );
  } else {
    const accounts = await getAccountChoices(user);
    const [customers, suppliers] = await Promise.all([
      prisma.customer.findMany({
        where: { organizationId: user.organizationId, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, phone: true },
      }),
      prisma.supplier.findMany({
        where: { organizationId: user.organizationId, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, taxNumber: true },
      }),
    ]);
    form = (
      <JournalEntryForm
        accounts={accounts.all}
        customers={customers.map((c) => ({ id: c.id, name: c.name, detail: c.phone }))}
        suppliers={suppliers.map((s) => ({
          id: s.id,
          name: s.name,
          detail: s.taxNumber ? `TRN ${s.taxNumber}` : null,
        }))}
        today={localDateString()}
        entry={{
          id: entry.id,
          entryNumber: entry.entryNumber,
          date: entry.entryDate.toISOString().slice(0, 10),
          description: entry.description ?? '',
          lines: entry.lines.map((line) => ({
            accountId: line.chartOfAccountId,
            partyId: line.customerId ?? line.supplierId ?? '',
            debit: line.debitAmount.gt(0) ? line.debitAmount.toFixed(2) : '',
            credit: line.creditAmount.gt(0) ? line.creditAmount.toFixed(2) : '',
            memo: line.description ?? '',
          })),
        }}
      />
    );
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href="/finance/accounting?view=journal"
            className="tracking-normal normal-case hover:text-foreground"
          >
            Journal
          </Link>
        }
        title={`Edit ${number}`}
        description={
          figuresLocked ? (
            <>
              Dated {formatCalendarDate(entry.entryDate)}. Its description and line notes can be
              corrected here. Its accounts and amounts can’t, because {figuresLocked}.
              {source.href ? (
                <>
                  {' '}
                  <Link href={source.href} className="text-primary hover:underline">
                    Open the record
                  </Link>
                  .
                </>
              ) : null}
            </>
          ) : (
            'Change anything — the date, accounts, amounts, the customer or supplier. It keeps its place in the journal, and the audit log keeps what it said before.'
          )
        }
        actions={
          canDelete ? (
            <DeleteEntryButton
              entryId={entry.id}
              entryNumber={number}
              withReversal={entry.reversals.length > 0}
            />
          ) : null
        }
      />
      <Panel className="w-full p-4 sm:p-8">{form}</Panel>
    </Stack>
  );
}
