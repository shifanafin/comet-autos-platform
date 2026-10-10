import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { AccessDenied } from '@/components/shared/access-denied';
import { listCreditNotes } from '@/lib/billing/credit-notes';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { toFils } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { loadPage, pageFrom } from '@/lib/pagination';
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
import { cn } from '@/lib/utils';

export const metadata = { title: 'Credit notes' };

const VIEWS = [
  { value: '', label: 'Issued' },
  { value: 'refund', label: 'Refund due' },
  { value: 'void', label: 'Void' },
] as const;

export default async function CreditNotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; show?: string; page?: string }>;
}) {
  const user = await requireUser();
  if (
    !hasPermission(
      user,
      'credit_note.view',
      user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
    )
  ) {
    return <AccessDenied what="credit notes" />;
  }
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const view = VIEWS.some((v) => v.value === params.show) ? (params.show ?? '') : '';
  const {
    result: { notes, total, totalAmount },
    info,
  } = await loadPage(pageFrom(params.page), (skip, take) =>
    listCreditNotes(
      user,
      {
        q: query,
        status: view === 'void' ? 'VOID' : view === 'refund' ? 'REFUND_DUE' : 'ISSUED',
      },
      take,
      skip,
    ),
  );
  const href = (show: string) => {
    const search = new URLSearchParams({
      ...(query ? { q: query } : {}),
      ...(show ? { show } : {}),
    });
    const text = search.toString();
    return `/finance/credit-notes${text ? `?${text}` : ''}`;
  };

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers & Sales"
        title="Credit notes"
        description="Tax credit notes, newest first. A credit note reduces an invoice after it was issued — a part returned, a price agreed afterwards, a job billed twice — without changing the invoice. Issue one from the invoice itself."
      />
      <Stack gap="base">
        <nav className="flex flex-wrap gap-2" aria-label="Credit note views">
          {VIEWS.map((option) => (
            <Link
              key={option.value}
              href={href(option.value)}
              aria-current={view === option.value ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium',
                view === option.value
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border bg-card hover:bg-muted',
              )}
            >
              {option.label}
            </Link>
          ))}
        </nav>
        <SearchField
          initialQuery={query}
          placeholder="Credit note, invoice, customer or reason"
          keep={view ? { show: view } : undefined}
        />
        {notes.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title={query ? `No credit note matches “${query}”` : 'No credit notes here'}
            description={
              query
                ? 'Try the credit note or invoice number.'
                : 'Open an invoice and choose Credit note to take part or all of it back.'
            }
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {total} credit note{total === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-foreground tabular-nums">
                {formatMoney(totalAmount)}
              </span>{' '}
              {view === 'void' ? 'withdrawn — none of it counts' : 'credited, VAT included'}
            </p>
            <Panel padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Credit note</TableHead>
                      <TableHead className="hidden md:table-cell">Invoice · customer</TableHead>
                      <TableHead className="hidden lg:table-cell">Reason</TableHead>
                      <TableHead className="text-right">VAT</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {notes.map((note) => {
                      const refundDue =
                        note.status === 'ISSUED' &&
                        toFils(note.refundAmount.toString()) > 0 &&
                        !note.refundedOn;
                      return (
                        <TableRow key={note.id}>
                          <TableCell>
                            <Link
                              href={`/finance/credit-notes/${note.id}`}
                              className="font-semibold hover:underline"
                            >
                              {note.creditNoteNumber}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {formatCalendarDate(note.issueDate)}
                            </span>
                            {note.status === 'VOID' ? (
                              <StatusPill tone="danger">Void</StatusPill>
                            ) : refundDue ? (
                              <StatusPill tone="warning">
                                {`Refund ${formatMoney(note.refundAmount.toString())} due`}
                              </StatusPill>
                            ) : null}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <Link
                              href={`/finance/invoices/${note.invoice.id}`}
                              className="font-medium hover:underline"
                            >
                              {note.invoice.invoiceNumber}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {note.invoice.customerName ?? note.customer.name}
                            </span>
                          </TableCell>
                          <TableCell className="hidden max-w-xs truncate lg:table-cell">
                            {note.reason}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(note.taxAmount.toString())}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              note.status === 'VOID'
                                ? 'text-muted-foreground line-through'
                                : 'font-semibold',
                            )}
                          >
                            {formatMoney(note.totalAmount.toString())}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                info={info}
                basePath="/finance/credit-notes"
                params={params}
                noun="credit notes"
              />
            </Panel>
          </>
        )}
      </Stack>
    </Stack>
  );
}
