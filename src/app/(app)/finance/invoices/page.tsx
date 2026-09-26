import Link from 'next/link';
import { Receipt, ReceiptText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { AccessDenied } from '@/components/shared/access-denied';
import { listInvoices } from '@/lib/billing/lists';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { ListFilters } from '@/components/inventory/list-filters';
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  RowCheckbox,
  RowRemoveButton,
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

const STATE = {
  UNPAID: { label: 'Unpaid', tone: 'warning' },
  PARTIALLY_PAID: { label: 'Partially paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
} as const;
const VOID_STATE = { label: 'Void', tone: 'danger' } as const;

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const user = await requireUser();
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  if (!hasPermission(user, 'invoice.view', scope)) {
    return <AccessDenied what="invoices" />;
  }
  const canCreate = hasPermission(user, 'invoice.create', scope);
  const canRemove = hasPermission(user, REMOVAL.invoices.permission, scope);
  const params = await searchParams;
  const { invoices, status } = await listInvoices(user, params);
  // Only an issued invoice with nothing paid can be voided — the same rule
  // as invoiceVoidBlocker; the server checks it again.
  const removable = (invoice: (typeof invoices)[number]) =>
    invoice.status === 'ISSUED' && invoice.balance.state === 'UNPAID';
  const removableRows = invoices
    .filter(removable)
    .map((invoice) => ({ id: invoice.id, label: invoice.invoiceNumber }));
  const owed = filsToString(
    invoices.reduce((sum, invoice) => sum + toFils(invoice.balance.balance), 0),
  );

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Finance"
        title="Invoices"
        description="Every tax invoice issued — billed from a job card, from a quotation, or on its own."
        actions={
          <>
            <ListDataActions
              entity="invoices"
              label="invoices"
              search={new URLSearchParams(
                Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
              ).toString()}
            />
            {canCreate ? (
              <LinkButton href="/finance/invoices/new" size="lg" className="w-full sm:w-auto">
                <ReceiptText />
                New invoice
              </LinkButton>
            ) : null}
          </>
        }
      />
      <Stack gap="base">
        <ListFilters
          placeholder="Invoice, customer, job card or registration"
          selects={[
            {
              name: 'status',
              label: 'Payment',
              options: [
                { value: '', label: 'All invoices' },
                { value: 'unpaid', label: 'Unpaid / part paid' },
                { value: 'paid', label: 'Paid' },
                { value: 'void', label: 'Void' },
              ],
            },
          ]}
        />
        {status === 'unpaid' && invoices.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Customers owe{' '}
            <span className="font-semibold text-warning tabular-nums">{formatMoney(owed)}</span> on{' '}
            {invoices.length} invoice
            {invoices.length === 1 ? '' : 's'}.
          </p>
        ) : null}
        {invoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={params.q || status ? 'No invoices match' : 'No invoices yet'}
            description={
              params.q || status
                ? 'Try another search, or clear the filters.'
                : 'Bill a customer for work done — a job card is not needed first.'
            }
            action={
              canCreate ? (
                <LinkButton href="/finance/invoices/new">
                  <ReceiptText />
                  New invoice
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <RecordSelection entity="invoices" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              <RecordList>
                {invoices.map((invoice) => {
                  const state =
                    invoice.status === 'VOID' ? VOID_STATE : STATE[invoice.balance.state];
                  return (
                    <RecordCard
                      key={invoice.id}
                      select={
                        removable(invoice) ? (
                          <RowCheckbox id={invoice.id} label={invoice.invoiceNumber} />
                        ) : null
                      }
                      action={
                        removable(invoice) ? (
                          <RowRemoveButton id={invoice.id} label={invoice.invoiceNumber} />
                        ) : null
                      }
                      className="relative"
                      title={
                        <Link
                          href={`/finance/invoices/${invoice.id}`}
                          className="after:absolute after:inset-0"
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      }
                      subtitle={invoice.customerName ?? invoice.customer.name}
                      amount={formatMoney(invoice.balance.total)}
                      status={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
                      details={[
                        {
                          label: 'Vehicle',
                          value: invoice.vehicle
                            ? `${invoice.vehicle.plateNumber} · ${invoice.vehicle.make} ${invoice.vehicle.model}`
                            : 'No vehicle',
                        },
                        { label: 'Issued', value: formatCalendarDate(invoice.issueDate) },
                        {
                          label: 'Balance',
                          value:
                            invoice.balance.balance === '0.00'
                              ? '—'
                              : formatMoney(invoice.balance.balance),
                        },
                      ]}
                    />
                  );
                })}
              </RecordList>

              <TableWrap>
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <SelectHead rows={removableRows} />
                      <TableHead>Invoice</TableHead>
                      <TableHead>Customer · vehicle</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Status</TableHead>
                      <RemoveHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((invoice) => {
                      const state =
                        invoice.status === 'VOID' ? VOID_STATE : STATE[invoice.balance.state];
                      return (
                        <TableRow key={invoice.id} className="relative">
                          <SelectCell
                            id={invoice.id}
                            label={invoice.invoiceNumber}
                            removable={removable(invoice)}
                          />
                          <TableCell>
                            <Link
                              href={`/finance/invoices/${invoice.id}`}
                              className="font-semibold after:absolute after:inset-0 hover:underline"
                            >
                              {invoice.invoiceNumber}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {formatCalendarDate(invoice.issueDate)}
                              {invoice.jobCard ? ` · ${invoice.jobCard.jobNumber}` : ''}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-3">
                              {invoice.vehicle ? (
                                <VehiclePlate
                                  plateNumber={invoice.vehicle.plateNumber}
                                  className="px-2 py-0.5 text-xs"
                                />
                              ) : null}
                              <span className="min-w-0">
                                <span className="block truncate">
                                  {invoice.customerName ?? invoice.customer.name}
                                </span>
                                {invoice.vehicle ? (
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {invoice.vehicle.make} {invoice.vehicle.model}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(invoice.balance.total)}
                          </TableCell>
                          <TableCell
                            className={
                              invoice.balance.balance === '0.00'
                                ? 'text-right text-muted-foreground tabular-nums'
                                : 'text-right font-semibold tabular-nums'
                            }
                          >
                            {formatMoney(invoice.balance.balance)}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={state.tone}>{state.label}</StatusPill>
                          </TableCell>
                          <RemoveCell
                            id={invoice.id}
                            label={invoice.invoiceNumber}
                            removable={removable(invoice)}
                          />
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableWrap>
            </Panel>
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
