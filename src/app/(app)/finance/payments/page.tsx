import Link from 'next/link';
import { Download, Wallet } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { canExport } from '@/lib/data-transfer/exports';
import { AccessDenied } from '@/components/shared/access-denied';
import { listPayments } from '@/lib/billing/lists';
import { formatDateTime, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { loadPage, pageFrom } from '@/lib/pagination';
import { StatusPill } from '@/components/shared/status-pill';
import { ActiveDeletedTabs } from '@/components/shared/active-deleted-tabs';
import { SearchField } from '@/components/shared/search-field';
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  SelectCell,
  SelectHead,
} from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const metadata = { title: 'Payments' };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; show?: string; page?: string }>;
}) {
  const user = await requireUser();
  if (
    !hasPermission(
      user,
      'payment.view',
      user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
    )
  ) {
    return <AccessDenied what="payments" />;
  }
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  // Received: the money that stands. Reversed: payments taken back, each
  // with its reversal — the original is never edited or deleted.
  const reversedView = params.show === 'reversed';
  const {
    result: { payments, total, totalShown, totalReversed },
    info,
  } = await loadPage(pageFrom(params.page), (skip, take) =>
    listPayments(user, { q: query, view: reversedView ? 'reversed' : 'received' }, take, skip),
  );
  const canRemove = hasPermission(
    user,
    REMOVAL.payments.permission,
    user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
  );
  // The same rule as reverseInvoicePayment; the server checks it again.
  const removable = (payment: (typeof payments)[number]) =>
    !reversedView &&
    payment.status === 'COMPLETED' &&
    !payment.reversalOfPaymentId &&
    payment.reversals.length === 0 &&
    payment.invoice.status !== 'VOID' &&
    payment.invoice.status !== 'CANCELLED';
  const labelOf = (payment: (typeof payments)[number]) =>
    payment.paymentNumber ?? `Payment on ${payment.invoice.invoiceNumber}`;
  const removableRows = payments
    .filter(removable)
    .map((payment) => ({ id: payment.id, label: labelOf(payment) }));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers & Sales"
        title="Receipts"
        description="Money received from customers, newest first. Payments are taken against an invoice — from the invoice itself or its job card. A payment entered wrongly is reversed, not deleted: it moves to Reversed, and the correct one is entered again."
        actions={
          <ListDataActions
            entity="payments"
            canExport={canExport(user, 'payments')}
            label="payments"
            search={query ? new URLSearchParams({ q: query }).toString() : ''}
          />
        }
      />
      <Stack gap="base">
        <ActiveDeletedTabs
          basePath="/finance/payments"
          deleted={reversedView}
          query={query}
          labels={['Received', 'Reversed']}
          show="reversed"
        />
        <SearchField
          initialQuery={query}
          placeholder="Receipt, reference, invoice or customer"
          keep={reversedView ? { show: 'reversed' } : undefined}
        />
        {payments.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={
              query
                ? `No payment matches “${query}”`
                : reversedView
                  ? 'No reversed payments'
                  : 'No payments yet'
            }
            description={
              query
                ? 'Try the receipt or invoice number.'
                : reversedView
                  ? 'A payment that is reversed from its invoice is listed here, with when and why.'
                  : 'Payments appear here once they are recorded against an invoice.'
            }
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {total} payment{total === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-foreground tabular-nums">
                {formatMoney(filsToString(reversedView ? totalReversed : totalShown))}
              </span>{' '}
              {reversedView ? 'reversed — none of it counts as received' : 'received'}
            </p>
            <RecordSelection entity="payments" enabled={canRemove}>
              <Panel padding="none" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/40">
                      <TableRow className="hover:bg-transparent">
                        <SelectHead rows={removableRows} />
                        <TableHead>Receipt</TableHead>
                        <TableHead className="hidden md:table-cell">Invoice · customer</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="w-0" />
                        <RemoveHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment) => (
                        <TableRow key={payment.id}>
                          <SelectCell
                            id={payment.id}
                            label={labelOf(payment)}
                            removable={removable(payment)}
                          />
                          <TableCell>
                            <span className="font-semibold">{payment.paymentNumber ?? '—'}</span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDateTime(payment.receivedAt)} · {payment.receivedBy.fullName}
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {payment.invoice.jobCard ? (
                              <Link
                                href={`/job-cards/${payment.invoice.jobCard.id}#payments`}
                                className="font-medium hover:underline"
                              >
                                {payment.invoice.invoiceNumber}
                              </Link>
                            ) : (
                              payment.invoice.invoiceNumber
                            )}
                            <span className="block text-xs text-muted-foreground">
                              {payment.invoice.customerName ?? '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            {payment.methodLabel}
                            {payment.referenceNumber ? (
                              <span className="block text-xs text-muted-foreground">
                                {payment.referenceNumber}
                              </span>
                            ) : null}
                            {payment.reversal ? (
                              <span className="mt-1 block text-xs text-muted-foreground">
                                <StatusPill tone="danger">Reversed</StatusPill>{' '}
                                {formatDateTime(payment.reversal.receivedAt)} by{' '}
                                {payment.reversal.receivedBy.fullName}
                                {payment.reversal.notes ? ` — ${payment.reversal.notes}` : ''}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell
                            className={
                              payment.reversal
                                ? 'text-right text-muted-foreground tabular-nums line-through'
                                : 'text-right font-semibold tabular-nums'
                            }
                          >
                            {formatMoney(payment.amount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <a
                              href={`/documents/receipt/${payment.id}?download=1`}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary hover:bg-primary/5"
                              aria-label={`Download receipt ${payment.paymentNumber ?? ''}`}
                            >
                              <Download className="size-4" />
                              <span className="hidden sm:inline">
                                {payment.reversal ? 'Reversed receipt' : 'Receipt'}
                              </span>
                            </a>
                          </TableCell>
                          <RemoveCell
                            id={payment.id}
                            label={labelOf(payment)}
                            removable={removable(payment)}
                          />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Pagination
                  info={info}
                  basePath="/finance/payments"
                  params={params}
                  noun="payments"
                />
              </Panel>
            </RecordSelection>
          </>
        )}
      </Stack>
    </Stack>
  );
}
