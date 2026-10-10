import Link from 'next/link';
import { ChevronRight, Info, Percent, ShieldCheck } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { listVatFilings, type VatFilingState } from '@/lib/accounting/vat-filing';
import { getAccountChoices } from '@/lib/accounting/reports';
import { localDateString } from '@/lib/format';
import { StatusPill } from '@/components/shared/status-pill';
import { FileVatReturnForm, SettleVatButton } from '@/components/accounting/vat-filing-controls';
import { getVatReturn, type VatReturn } from '@/lib/finance/vat';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const FILING_STATE: Record<
  VatFilingState,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }
> = {
  PAYMENT_DUE: { label: 'Payment due', tone: 'warning' },
  OVERDUE: { label: 'Payment overdue', tone: 'danger' },
  PAID: { label: 'Paid', tone: 'success' },
  REFUND_DUE: { label: 'Refund due from FTA', tone: 'info' },
  REFUNDED: { label: 'Refunded', tone: 'success' },
  NIL: { label: 'Nil return', tone: 'neutral' },
};

/** How a VAT201 return is submitted and paid — shown beside the figures. */
function HowToFile({ emirate }: { emirate: VatReturn['emirate'] }) {
  const steps = [
    'Choose the VAT period above (usually a calendar quarter) and check the figures and the documents listed below.',
    'Sign in to EmaraTax at tax.gov.ae, open VAT, then "VAT201 – VAT Returns", and start the return for the same period.',
    `Box ${emirate.box} — enter the standard-rated supplies and their VAT against ${emirate.name}. Box 4 — the zero-rated supplies, and Box 5 — the exempt supplies, if any.`,
    'Box 9 — enter the standard-rated expenses and the VAT recoverable on them.',
    'Check that Box 14 (payable or refundable) matches the figure here, tick the declaration and submit. Note the reference EmaraTax gives you.',
    'Record the return here as filed, with that reference. Filing is due by the 28th day after the period ends.',
    'Pay by the same date — by bank transfer to your GIBAN (shown in EmaraTax) or by card — then record the payment here.',
  ];
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/** A document behind a box of the return, opened with a click. */
interface BoxDocument {
  key: string;
  href: string;
  number: string;
  date: string;
  party: string;
  net: string;
  vat: string;
}

const BOX_ROW =
  'grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[2.5rem_1fr_9rem_9rem] sm:px-6';

/**
 * One line of the return: its box number, what it is, the amount and the
 * VAT. A box with documents behind it opens to list them — each one a link
 * to the invoice, expense or delivery itself.
 */
function Box({
  box,
  label,
  amount,
  vat,
  strong,
  documents,
}: {
  box: string;
  label: string;
  amount?: string;
  vat?: string;
  strong?: boolean;
  documents?: BoxDocument[];
}) {
  const figures = (
    <>
      <span className="font-mono text-xs text-muted-foreground">{box}</span>
      <span className="flex items-center gap-2 text-sm">
        {documents ? (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        ) : null}
        {label}
        {documents ? (
          <span className="text-xs font-normal text-muted-foreground">
            {documents.length} document{documents.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </span>
      <span className="text-right text-sm tabular-nums sm:col-auto">
        {amount !== undefined ? formatMoney(amount) : ''}
      </span>
      <span className="col-start-3 text-right text-sm tabular-nums sm:col-start-auto">
        {vat !== undefined ? formatMoney(vat) : ''}
      </span>
    </>
  );
  if (!documents) {
    return <li className={cn(BOX_ROW, strong && 'bg-muted/40 font-semibold')}>{figures}</li>;
  }
  return (
    <li>
      <details className="group">
        <summary
          className={cn(
            BOX_ROW,
            'cursor-pointer list-none hover:bg-muted/40 [&::-webkit-details-marker]:hidden',
            strong && 'bg-muted/40 font-semibold',
          )}
        >
          {figures}
        </summary>
        {documents.length === 0 ? (
          <p className="border-t border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground sm:px-6 sm:pl-[4.25rem]">
            Nothing in this box for the period.
          </p>
        ) : (
          <ul className="divide-y divide-border border-t border-border bg-muted/20">
            {documents.map((doc) => (
              <li key={doc.key}>
                <Link
                  href={doc.href}
                  className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-2.5 text-sm hover:bg-muted sm:grid-cols-[2.5rem_1fr_9rem_9rem] sm:px-6"
                >
                  <span className="hidden sm:block" />
                  <span className="min-w-0">
                    <span className="font-medium text-primary">{doc.number}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {doc.date} · {doc.party}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">{formatMoney(doc.net)}</span>
                  <span className="col-start-2 text-right text-muted-foreground tabular-nums sm:col-start-auto">
                    {formatMoney(doc.vat)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/** A list of the documents behind one side of the return. */
function DocumentTable({
  rows,
  empty,
}: {
  rows: {
    key: string;
    href?: string;
    number: string;
    date: string;
    party: string;
    detail?: string | null;
    net: string;
    vat: string;
  }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </Panel>
    );
  }
  return (
    <Panel padding="none" className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="w-28 px-4 py-3 pl-6">Date</th>
              <th className="px-2 py-3">Document</th>
              <th className="w-28 px-2 py-3 text-right">Net</th>
              <th className="w-28 px-4 py-3 pr-6 text-right">VAT</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-4 py-3 pl-6 tabular-nums whitespace-nowrap">{row.date}</td>
                <td className="px-2 py-3">
                  {row.href ? (
                    <Link href={row.href} className="font-mono text-xs hover:underline">
                      {row.number}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{row.number}</span>
                  )}
                  <span className="block">{row.party}</span>
                  {row.detail ? (
                    <span className="block text-xs text-muted-foreground">{row.detail}</span>
                  ) : null}
                </td>
                <td className="px-2 py-3 text-right tabular-nums whitespace-nowrap">
                  {formatMoney(row.net)}
                </td>
                <td className="px-4 py-3 pr-6 text-right font-medium tabular-nums whitespace-nowrap">
                  {formatMoney(row.vat)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default async function VatPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let data: VatReturn;
  try {
    data = await getVatReturn(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the VAT return" />;
    throw error;
  }
  const { period, boxes } = data;
  const payable = boxes.netFils >= 0;
  const canFile = hasPermission(user, 'vat.create');
  const canSeeFilings = hasPermission(user, 'vat.view');
  const today = localDateString();
  const [filings, money] = canSeeFilings
    ? await Promise.all([
        listVatFilings(user),
        canFile ? getAccountChoices(user).then((c) => c.money) : [],
      ])
    : [[], []];
  const alreadyFiled = filings.find(
    (filing) =>
      filing.periodFrom.toISOString().slice(0, 10) <= period.to &&
      filing.periodTo.toISOString().slice(0, 10) >= period.from,
  );
  const ended = period.to < today;

  // The documents behind each box, for opening them from the return.
  const saleHref = (row: VatReturn['sales'][number]) => `/finance/invoices/${row.id}`;
  const standardSales: BoxDocument[] = data.sales
    .filter((row) => row.standard !== '0.00')
    .map((row) => ({
      key: row.id,
      href: saleHref(row),
      number: row.number,
      date: formatCalendarDate(row.date),
      party: row.party,
      net: row.standard,
      vat: row.vat,
    }));
  // Credit notes sit in the same boxes, taking their part back off.
  const credited = (part: 'standard' | 'zeroRated' | 'exempt', withVat: boolean) =>
    data.credits
      .filter((row) => row[part] !== '0.00')
      .map((row) => ({
        key: `credit-${row.id}`,
        href: `/finance/credit-notes/${row.id}`,
        number: row.number,
        date: formatCalendarDate(row.date),
        party: `${row.party} · credits ${row.invoiceNumber}`,
        net: `-${row[part]}`,
        vat: withVat ? `-${row.vat}` : '0.00',
      }));
  // Months before these books, entered as totals.
  const priorHref = '/finance/accounting/prior-periods';
  const priorLabel = (row: VatReturn['priorPeriods'][number]) =>
    `${formatCalendarDate(row.from)} – ${formatCalendarDate(row.to)}`;
  const priorSales: BoxDocument[] = data.priorPeriods
    .filter((row) => row.sales !== '0.00')
    .map((row) => ({
      key: `prior-sales-${row.id}`,
      href: priorHref,
      number: 'Month totals',
      date: priorLabel(row),
      party: 'Before these books',
      net: row.sales,
      vat: row.salesVat,
    }));
  const standardDocuments = [...standardSales, ...credited('standard', true), ...priorSales];
  const salesIn = (part: 'zeroRated' | 'exempt'): BoxDocument[] => [
    ...data.sales
      .filter((row) => row[part] !== '0.00')
      .map((row) => ({
        key: row.id,
        href: saleHref(row),
        number: row.number,
        date: formatCalendarDate(row.date),
        party: row.party,
        net: row[part],
        vat: '0.00',
      })),
    ...credited(part, false),
  ];
  const zeroRatedSales = salesIn('zeroRated');
  const exemptSales = salesIn('exempt');
  const expenseDocuments: BoxDocument[] = [
    ...data.expenses.map((row) => ({
      key: `expense-${row.id}`,
      href: `/finance/expenses?q=${encodeURIComponent(row.number ?? row.description)}`,
      number: row.number ?? 'Expense',
      date: formatCalendarDate(row.date),
      party: row.party,
      net: row.net,
      vat: row.vat,
    })),
    ...data.purchases.map((row) => ({
      key: `purchase-${row.id}`,
      href: `/inventory/purchases/${row.id}`,
      number: row.number,
      date: formatDate(row.date),
      party: row.party,
      net: row.net,
      vat: row.vat,
    })),
    ...data.priorPeriods
      .filter((row) => row.expenses !== '0.00')
      .map((row) => ({
        key: `prior-costs-${row.id}`,
        href: priorHref,
        number: 'Month totals',
        date: priorLabel(row),
        party: 'Before these books',
        net: row.expenses,
        vat: row.purchasesVat,
      })),
  ];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Accounting"
        title="VAT returns"
        description={`The figures for your VAT return, from ${formatDate(period.from)} to ${formatDate(period.to)}. Check them before filing — this prepares the return, it does not submit it.`}
      />

      <FinancePeriodPicker
        period={period}
        basePath="/finance/vat"
        presets={['month', 'last-month', 'quarter', 'last-quarter', 'year']}
      />

      {!data.registered ? (
        <Panel className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">This workshop is not VAT-registered</p>
            <p className="text-sm text-muted-foreground">
              No VAT is charged or recovered, so there is nothing to file. Turn VAT registration on
              in{' '}
              <Link href="/settings" className="text-primary hover:underline">
                Settings
              </Link>{' '}
              if that changes.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          {data.awaitingTaxInvoice.purchases > 0 ? (
            <p className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm sm:px-5">
              <span>
                {formatMoney(data.awaitingTaxInvoice.vat)} of input VAT on{' '}
                {data.awaitingTaxInvoice.purchases} purchase
                {data.awaitingTaxInvoice.purchases === 1 ? '' : 's'} is not in this return — the
                shop&apos;s tax invoice hasn&apos;t been matched yet.
              </span>
              <Link href="/inventory/purchases/bills" className="font-medium text-primary hover:underline">
                Bills to match
              </Link>
            </p>
          ) : null}
          <Panel className="grid gap-6 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Output VAT</span>
              <span className="text-2xl leading-none font-semibold tabular-nums">
                {formatMoney(boxes.outputVat)}
              </span>
              <span className="text-xs text-muted-foreground">
                On {data.sales.length} tax invoice{data.sales.length === 1 ? '' : 's'}
                {data.credits.length > 0
                  ? `, less ${data.credits.length} credit note${data.credits.length === 1 ? '' : 's'}`
                  : ''}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Input VAT</span>
              <span className="text-2xl leading-none font-semibold tabular-nums">
                {formatMoney(boxes.inputVat)}
              </span>
              <span className="text-xs text-muted-foreground">Expenses and parts received</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {payable ? 'VAT payable' : 'VAT refundable'}
              </span>
              <span
                className={cn(
                  'text-2xl leading-none font-semibold tabular-nums',
                  payable ? 'text-foreground' : 'text-success',
                )}
              >
                {formatMoney(boxes.net.replace('-', ''))}
              </span>
              <span className="text-xs text-muted-foreground">
                {data.taxNumber ? `TRN ${data.taxNumber}` : 'No TRN recorded in Settings'} · at{' '}
                {data.rate.replace(/\.?0+$/, '')}%
              </span>
            </div>
          </Panel>

          <Section
            title="The return"
            description="Laid out as the VAT201 form. Amounts exclude VAT."
          >
            <Panel padding="none" className="overflow-hidden">
              <div className="hidden grid-cols-[2.5rem_1fr_9rem_9rem] gap-x-3 bg-muted/40 px-6 py-3 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase sm:grid">
                <span>Box</span>
                <span>Description</span>
                <span className="text-right">Amount</span>
                <span className="text-right">VAT</span>
              </div>
              <ul className="divide-y divide-border">
                <Box
                  box={data.emirate.box}
                  label={`Standard-rated supplies in ${data.emirate.name}`}
                  amount={boxes.standardSupplies}
                  vat={boxes.outputVat}
                  documents={standardDocuments}
                />
                <Box
                  box="4"
                  label="Zero-rated supplies"
                  amount={boxes.zeroRatedSupplies}
                  documents={zeroRatedSales}
                />
                <Box
                  box="5"
                  label="Exempt supplies"
                  amount={boxes.exemptSupplies}
                  documents={exemptSales}
                />
                <Box
                  box="8"
                  label="Total supplies"
                  amount={boxes.totalSupplies}
                  vat={boxes.outputVat}
                  strong
                />
                <Box
                  box="9"
                  label="Standard-rated expenses"
                  amount={boxes.standardExpenses}
                  vat={boxes.inputVat}
                  documents={expenseDocuments}
                />
                <Box
                  box="11"
                  label="Total expenses"
                  amount={boxes.standardExpenses}
                  vat={boxes.inputVat}
                  strong
                />
                <Box box="12" label="Total value of due tax" vat={boxes.outputVat} />
                <Box box="13" label="Total value of recoverable tax" vat={boxes.inputVat} />
                <Box
                  box="14"
                  label={payable ? 'Payable tax for the period' : 'Refundable tax for the period'}
                  vat={boxes.net.replace('-', '')}
                  strong
                />
              </ul>
            </Panel>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              Standard-rated supplies are reported against {data.emirate.name}, the emirate set in
              Settings; credit notes issued in the period are already taken off. Lines marked out of
              scope
              {boxes.outOfScopeSupplies !== '0.00'
                ? ` (${formatMoney(boxes.outOfScopeSupplies)} this period)`
                : ''}{' '}
              are not supplies and are left off the return. Tourist refunds, reverse-charge and
              import boxes (2, 3, 6, 7 and 10) do not arise for a workshop selling locally — add
              them on the form only if they apply.
            </p>
          </Section>
        </>
      )}

      <Section
        title="Sales"
        description="Tax invoices issued in the period. Pro-forma, draft, voided and cancelled invoices are not supplies."
      >
        <DocumentTable
          empty="No tax invoices were issued in this period."
          rows={data.sales.map((row) => ({
            key: row.id,
            href: row.jobCardId ? `/job-cards/${row.jobCardId}` : `/finance/invoices/${row.id}`,
            number: row.number,
            date: formatCalendarDate(row.date),
            party: row.party,
            detail: row.taxNumber ? `TRN ${row.taxNumber}` : null,
            net: row.net,
            vat: row.vat,
          }))}
        />
      </Section>

      {data.credits.length > 0 ? (
        <Section
          title="Credit notes"
          description="Tax credit notes issued in the period. Each one reduces the supplies and output VAT of this return, whatever the date of the invoice it corrects."
        >
          <DocumentTable
            empty=""
            rows={data.credits.map((row) => ({
              key: row.id,
              href: `/finance/credit-notes/${row.id}`,
              number: row.number,
              date: formatCalendarDate(row.date),
              party: row.party,
              detail: `Against ${row.invoiceNumber} — ${row.reason}`,
              net: `-${row.net}`,
              vat: `-${row.vat}`,
            }))}
          />
        </Section>
      ) : null}

      <Section
        title="Parts received and returned"
        description={`Deliveries booked into stock in the period, less parts returned to the supplier, with the VAT on them${data.registered ? ` (${formatMoney(boxes.purchaseVat)})` : ''}.`}
      >
        <DocumentTable
          empty="No parts carrying VAT were received in this period."
          rows={data.purchases.map((row) => ({
            key: row.id,
            href: `/inventory/purchases/${row.id}`,
            number: row.number,
            date: formatDate(row.date),
            party: row.party,
            detail: row.reference ? `Supplier invoice ${row.reference}` : null,
            net: row.net,
            vat: row.vat,
          }))}
        />
      </Section>

      {data.registered && canSeeFilings ? (
        <Section
          title="Filing with the FTA"
          description={`A return for this period is due by ${formatCalendarDate(data.dueDate)}, and so is any payment.`}
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <HowToFile emirate={data.emirate} />
            </Panel>
            <Panel>
              {alreadyFiled ? (
                <p className="text-sm">
                  The return for {formatCalendarDate(alreadyFiled.periodFrom)} to{' '}
                  {formatCalendarDate(alreadyFiled.periodTo)} was recorded as filed on{' '}
                  {formatCalendarDate(alreadyFiled.filedOn)}
                  {alreadyFiled.ftaReference ? ` (FTA ref. ${alreadyFiled.ftaReference})` : ''}. See
                  the filed returns below.
                </p>
              ) : !ended ? (
                <p className="text-sm text-muted-foreground">
                  This period hasn&apos;t ended yet. Once it has, file the return on EmaraTax and
                  record it here.
                </p>
              ) : canFile ? (
                <FileVatReturnForm
                  from={period.from}
                  to={period.to}
                  today={today}
                  net={boxes.net}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only someone who manages the accounts can record a filed return.
                </p>
              )}
            </Panel>
          </div>
        </Section>
      ) : null}

      {canSeeFilings && filings.length > 0 ? (
        <Section
          title="Filed returns"
          description="Every return recorded as filed, and whether it has been paid."
        >
          <Panel padding="none" className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-2 py-3">Filed</th>
                  <th className="px-2 py-3 text-right">Output VAT</th>
                  <th className="px-2 py-3 text-right">Input VAT</th>
                  <th className="px-2 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filings.map((filing) => (
                  <tr key={filing.id}>
                    <td className="px-4 py-3">
                      {formatCalendarDate(filing.periodFrom)} –{' '}
                      {formatCalendarDate(filing.periodTo)}
                      <span className="block text-xs text-muted-foreground">
                        Due {formatCalendarDate(filing.dueOn)}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      {formatCalendarDate(filing.filedOn)}
                      <span className="block text-xs text-muted-foreground">
                        {filing.ftaReference ? `Ref. ${filing.ftaReference}` : 'No reference'} ·{' '}
                        {filing.filedBy.fullName}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(filing.outputVat.toString())}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(filing.inputVat.toString())}
                    </td>
                    <td className="px-2 py-3 text-right font-medium tabular-nums">
                      {formatMoney(filing.netVat.toString().replace('-', ''))}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {filing.netFils < 0 ? 'refundable' : 'payable'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={FILING_STATE[filing.state].tone}>
                          {FILING_STATE[filing.state].label}
                        </StatusPill>
                        {filing.settledOn ? (
                          <span className="text-xs text-muted-foreground">
                            {formatCalendarDate(filing.settledOn)}
                          </span>
                        ) : canFile && filing.state !== 'NIL' ? (
                          <SettleVatButton
                            filingId={filing.id}
                            net={filing.netVat.toString()}
                            today={today}
                            accounts={money}
                          />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </Section>
      ) : null}

      <Section
        title="Expenses"
        description={`Recorded expenses that carry VAT${data.registered ? ` (${formatMoney(boxes.expenseVat)})` : ''}. Voided expenses never count.`}
      >
        {data.expenses.length === 0 && data.sales.length === 0 && data.purchases.length === 0 ? (
          <EmptyState
            icon={Percent}
            title="Nothing to report for this period"
            description="Choose a different period, or record invoices and expenses first."
          />
        ) : (
          <DocumentTable
            empty="No expenses carrying VAT were recorded in this period."
            rows={data.expenses.map((row) => ({
              key: row.id,
              href: '/finance/expenses',
              number: row.number ?? '—',
              date: formatCalendarDate(row.date),
              party: row.party,
              detail: row.description,
              net: row.net,
              vat: row.vat,
            }))}
          />
        )}
      </Section>

      {data.bankCharges.length ? (
        <Section
          title="Bank charges"
          description={`The card machine's fee the bank kept on settlements, with its VAT — less any fee recovered from someone the card money was for, paid over on a payment voucher${data.registered ? ` (${formatMoney(boxes.bankChargesVat)})` : ''}.`}
        >
          <DocumentTable
            empty="No bank charges with VAT in this period."
            rows={data.bankCharges.map((row) => ({
              key: row.id,
              href: row.href,
              number: row.number,
              date: formatCalendarDate(row.date),
              party: row.party,
              detail: row.description,
              net: row.net,
              vat: row.vat,
            }))}
          />
        </Section>
      ) : null}
    </Stack>
  );
}
