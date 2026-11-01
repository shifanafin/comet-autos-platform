import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileSpreadsheet, Truck, User } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import {
  getCustomerStatement,
  getStatementIssuer,
  getStatementParties,
  getSupplierStatement,
  type StatementLine,
} from '@/lib/finance/statements';
import { formatAmount, formatCalendarDate, formatMoney, localDateString } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { SearchField } from '@/components/shared/search-field';
import { PrintButton } from '@/components/shared/print-button';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Statements' };

/** "1,250.00", or "1,250.00 in credit" for a balance the other way; the column says AED. */
function balanceText(amount: string, creditLabel: string) {
  return amount.startsWith('-')
    ? `${formatAmount(amount.slice(1))} ${creditLabel}`
    : formatAmount(amount);
}

function StatementTable({
  lines,
  opening,
  closing,
  totalDebits,
  totalCredits,
  from,
  to,
  debitLabel,
  creditLabel,
  reverseLabel,
}: {
  lines: StatementLine[];
  opening: string;
  closing: string;
  totalDebits: string;
  totalCredits: string;
  from: string;
  to: string;
  debitLabel: string;
  creditLabel: string;
  /** How a balance the other way round is marked, e.g. "CR". */
  reverseLabel: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          <tr>
            <th className="w-28 px-4 py-3 pl-6">Date</th>
            <th className="px-2 py-3">Transaction</th>
            <th className="w-32 px-2 py-3 text-right">{debitLabel} (AED)</th>
            <th className="w-32 px-2 py-3 text-right">{creditLabel} (AED)</th>
            <th className="w-36 px-4 py-3 pr-6 text-right">Balance (AED)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          <tr className="bg-muted/20">
            <td className="px-4 py-2.5 pl-6 tabular-nums">{formatCalendarDate(from)}</td>
            <td className="px-2 py-2.5 font-medium" colSpan={3}>
              Balance brought forward
            </td>
            <td className="px-4 py-2.5 pr-6 text-right font-medium tabular-nums">
              {balanceText(opening, reverseLabel)}
            </td>
          </tr>
          {lines.map((line) => (
            <tr key={line.key}>
              <td className="px-4 py-2.5 pl-6 tabular-nums whitespace-nowrap">
                {formatCalendarDate(line.date)}
              </td>
              <td className="px-2 py-2.5">
                <span className="font-medium">{line.kind}</span>{' '}
                {line.href ? (
                  <Link href={line.href} className="font-mono text-xs text-primary hover:underline">
                    {line.reference}
                  </Link>
                ) : (
                  <span className="font-mono text-xs">{line.reference}</span>
                )}
                <span className="block text-xs text-muted-foreground">{line.description}</span>
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">
                {line.debit ? formatAmount(line.debit) : ''}
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">
                {line.credit ? formatAmount(line.credit) : ''}
              </td>
              <td className="px-4 py-2.5 pr-6 text-right tabular-nums">
                {balanceText(line.balance, reverseLabel)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-border">
          <tr>
            <td className="px-4 py-3 pl-6 tabular-nums">{formatCalendarDate(to)}</td>
            <td className="px-2 py-3 font-semibold">Closing balance</td>
            <td className="px-2 py-3 text-right tabular-nums">{formatAmount(totalDebits)}</td>
            <td className="px-2 py-3 text-right tabular-nums">{formatAmount(totalCredits)}</td>
            <td className="px-4 py-3 pr-6 text-right font-semibold tabular-nums">
              {balanceText(closing, reverseLabel)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    supplier?: string;
    from?: string;
    to?: string;
    q?: string;
  }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'invoice.view')) return <AccessDenied what="statements" />;
  const params = await searchParams;
  const period = { from: params.from, to: params.to };

  let statement;
  let kind: 'customer' | 'supplier' | null = null;
  try {
    if (params.customer) {
      kind = 'customer';
      statement = await getCustomerStatement(user, params.customer, period);
    } else if (params.supplier) {
      kind = 'supplier';
      statement = await getSupplierStatement(user, params.supplier, period);
    }
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="this statement" />;
    throw error;
  }

  if (!statement || !kind) {
    const query = (params.q ?? '').trim();
    const parties = await getStatementParties(user, query);
    const canSuppliers = hasPermission(user, 'supplier_payment.view');
    return (
      <Stack gap="2xl" className="animate-in fade-in duration-300">
        <PageHeader
          eyebrow="Receivables & payables"
          title="Statements of account"
          description="A statement of account for a customer or a supplier: the balance brought forward, every invoice, credit note, payment and refund in the period with a running balance, and the balance now. Print it or save it as a PDF to send."
        />
        <SearchField initialQuery={query} placeholder="Customer or supplier name" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Customers" description="What they owe the workshop.">
            <PartyList
              icon={User}
              rows={parties.customers}
              href={(id) => `/finance/statements?customer=${id}`}
              empty="No customer matches."
            />
          </Section>
          {canSuppliers ? (
            <Section title="Suppliers" description="What the workshop owes them.">
              <PartyList
                icon={Truck}
                rows={parties.suppliers}
                href={(id) => `/finance/statements?supplier=${id}`}
                empty="No supplier matches."
              />
            </Section>
          ) : null}
        </div>
      </Stack>
    );
  }

  const issuer = await getStatementIssuer(user);
  const isCustomer = kind === 'customer';
  const partyParam = isCustomer
    ? { customer: statement.party.id }
    : { supplier: statement.party.id };
  const customerStatement = isCustomer
    ? (statement as Awaited<ReturnType<typeof getCustomerStatement>>)
    : null;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/statements" className="text-primary hover:underline">
            Statements
          </Link>
        }
        title={statement.party.name}
        description={
          isCustomer
            ? 'Statement of account: what this customer owes the workshop.'
            : 'Statement of account: what the workshop owes this supplier. Check it against the statement the supplier sends.'
        }
        actions={<PrintButton />}
      />

      <form className="flex flex-wrap items-end gap-3" action="/finance/statements">
        {Object.entries(partyParam).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          From
          <Input type="date" name="from" defaultValue={statement.period.from} className="h-10" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <Input
            type="date"
            name="to"
            defaultValue={statement.period.to}
            max={localDateString()}
            className="h-10"
          />
        </label>
        <Button type="submit" variant="outline" className="h-10">
          Show
        </Button>
      </form>

      <Panel padding="none" className="print-sheet overflow-hidden">
        <div className="flex flex-col gap-6 border-b border-border px-4 py-6 sm:flex-row sm:justify-between sm:px-6">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-lg font-semibold">{issuer.legalName ?? issuer.name}</span>
            {issuer.address ? (
              <span className="text-muted-foreground">{issuer.address}</span>
            ) : null}
            <span className="text-muted-foreground">
              {[issuer.phone, issuer.email].filter(Boolean).join(' · ')}
            </span>
            {issuer.taxNumber ? (
              <span className="text-muted-foreground">TRN {issuer.taxNumber}</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-0.5 text-sm sm:text-right">
            <span className="text-lg font-semibold">Statement of account</span>
            <span className="text-muted-foreground">
              {formatCalendarDate(statement.period.from)} to{' '}
              {formatCalendarDate(statement.period.to)}
            </span>
            <span className="mt-2 font-medium">{statement.party.name}</span>
            {statement.party.address ? (
              <span className="text-muted-foreground">{statement.party.address}</span>
            ) : null}
            {statement.party.phone ? (
              <span className="text-muted-foreground">{statement.party.phone}</span>
            ) : null}
            {'taxNumber' in statement.party && statement.party.taxNumber ? (
              <span className="text-muted-foreground">TRN {statement.party.taxNumber}</span>
            ) : null}
          </div>
        </div>

        {statement.lines.length === 0 && statement.opening === '0.00' ? (
          <div className="px-4 py-6 sm:px-6">
            <EmptyState
              icon={FileSpreadsheet}
              title="Nothing in this period"
              description="No invoices, credit notes or payments up to the end of the period."
            />
          </div>
        ) : (
          <StatementTable
            lines={statement.lines}
            opening={statement.opening}
            closing={statement.closing}
            totalDebits={statement.totalDebits}
            totalCredits={statement.totalCredits}
            from={statement.period.from}
            to={statement.period.to}
            debitLabel={isCustomer ? 'Charged' : 'Paid / returned'}
            creditLabel={isCustomer ? 'Paid / credited' : 'Billed'}
            reverseLabel={isCustomer ? 'in credit' : 'owed to us'}
          />
        )}

        {customerStatement ? (
          <div className="flex flex-col gap-4 border-t border-border px-4 py-5 sm:px-6">
            <p className="text-sm font-semibold">
              Unpaid today: {formatMoney(customerStatement.totalDue)}
            </p>
            {customerStatement.advanceHeld !== '0.00' ? (
              <p className="text-sm text-muted-foreground">
                {`Paid in advance and held for the customer: ${formatMoney(customerStatement.advanceHeld)} — not yet applied to an invoice.`}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {customerStatement.ageing.map((bucket) => (
                <div key={bucket.label} className="rounded-lg border border-border px-3 py-2">
                  <span className="block text-xs text-muted-foreground">{bucket.label}</span>
                  <span className="text-sm font-medium tabular-nums">
                    {formatMoney(bucket.amount)}
                  </span>
                </div>
              ))}
            </div>
            {customerStatement.openInvoices.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Open invoices:{' '}
                {customerStatement.openInvoices
                  .map(
                    (invoice) =>
                      `${invoice.number} (due ${formatCalendarDate(invoice.dueDate)}, ${formatMoney(invoice.due)})`,
                  )
                  .join('; ')}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6">
          {isCustomer
            ? 'Please let us know within 14 days if anything on this statement does not match your records. Amounts in UAE dirhams (AED), VAT included.'
            : 'Deliveries are valued at the purchase price with VAT, as received into stock. Amounts in UAE dirhams (AED).'}
        </p>
      </Panel>
    </Stack>
  );
}

function PartyList({
  icon: Icon,
  rows,
  href,
  empty,
}: {
  icon: typeof User;
  rows: { id: string; name: string; phone: string | null }[];
  href: (id: string) => string;
  empty: string;
}) {
  return (
    <Panel padding="none">
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={href(row.id)}
                className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60 sm:px-6"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                <span className="text-xs text-muted-foreground">{row.phone}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
