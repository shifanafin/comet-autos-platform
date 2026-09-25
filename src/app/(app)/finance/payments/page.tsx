import Link from 'next/link';
import { Download, Wallet } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { AccessDenied } from '@/components/shared/access-denied';
import { listPayments } from '@/lib/billing/lists';
import { formatDateTime, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';
import { SearchField } from '@/components/shared/search-field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const metadata = { title: 'Payments — Comet Autos' };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  if (
    !hasPermission(
      user,
      'invoice.view',
      user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
    )
  ) {
    return <AccessDenied what="payments" />;
  }
  const query = ((await searchParams).q ?? '').trim();
  const { payments, totalShown } = await listPayments(user, { q: query });

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Finance"
        title="Payments"
        description="Money received from customers, newest first. Payments are taken against an invoice — from the invoice itself or its work order."
        actions={
          <ListDataActions
            entity="payments"
            label="payments"
            search={query ? new URLSearchParams({ q: query }).toString() : ''}
          />
        }
      />
      <Stack gap="base">
        <SearchField initialQuery={query} placeholder="Receipt, reference, invoice or customer" />
        {payments.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={query ? `No payment matches “${query}”` : 'No payments yet'}
            description={
              query
                ? 'Try the receipt or invoice number.'
                : 'Payments appear here once they are recorded against an invoice.'
            }
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {payments.length} payment{payments.length === 1 ? '' : 's'} shown ·{' '}
              <span className="font-semibold text-foreground tabular-nums">
                {formatMoney(filsToString(totalShown))}
              </span>{' '}
              received
            </p>
            <Panel padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Receipt</TableHead>
                      <TableHead className="hidden md:table-cell">Invoice · customer</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="w-0" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((payment) => (
                      <TableRow key={payment.id}>
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
                          {payment.status !== 'COMPLETED' ? (
                            <StatusPill tone="neutral">{payment.status.toLowerCase()}</StatusPill>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatMoney(payment.amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <a
                            href={`/documents/receipt/${payment.id}?download=1`}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary hover:bg-primary/5"
                            aria-label={`Download receipt ${payment.paymentNumber ?? ''}`}
                          >
                            <Download className="size-4" />
                            <span className="hidden sm:inline">Receipt</span>
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Panel>
          </>
        )}
      </Stack>
    </Stack>
  );
}
