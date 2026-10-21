import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getOtherIncome } from '@/lib/finance/other-income';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { PrintButton } from '@/components/shared/print-button';
import { StatusPill } from '@/components/shared/status-pill';
import { VoidOtherIncomeButton } from '@/components/finance/other-income-form';

export const metadata = { title: 'Income receipt' };

/**
 * One receipt for money received — printable. With VAT it carries what a
 * simplified tax invoice must show: the business, its TRN, the date, what for,
 * the total and the VAT in it.
 */
export default async function OtherIncomeReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  let row;
  try {
    row = await getOtherIncome(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="rent & other income" />;
    throw error;
  }
  const isVoid = row.status === 'VOID';
  const withVat = Number(row.vatAmount.toString()) > 0;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/money/income" className="text-primary hover:underline">
            Rent & other income
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {row.incomeNumber}
            {isVoid ? <StatusPill tone="neutral">Void</StatusPill> : null}
          </span>
        }
        description={`${row.receivedFrom} · ${formatCalendarDate(row.receivedOn)} · ${formatMoney(row.amount.toString())}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <PrintButton />
            {row.canVoid ? <VoidOtherIncomeButton id={row.id} label={row.incomeNumber} /> : null}
          </span>
        }
      />

      <Panel className="print-sheet mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{row.business.name}</p>
            {row.business.address ? (
              <p className="text-sm text-muted-foreground">{row.business.address}</p>
            ) : null}
            {row.business.phone ? (
              <p className="text-sm text-muted-foreground">{row.business.phone}</p>
            ) : null}
            {row.business.taxNumber ? (
              <p className="text-sm">{`TRN ${row.business.taxNumber}`}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{withVat ? 'Tax invoice — receipt' : 'Receipt'}</p>
            <p className="text-sm">{row.incomeNumber}</p>
            <p className="text-sm">{formatCalendarDate(row.receivedOn)}</p>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Received from</dt>
          <dd>{row.receivedFrom}</dd>
          <dt className="text-muted-foreground">For</dt>
          <dd>{row.description}</dd>
          <dt className="text-muted-foreground">Paid into</dt>
          <dd>{row.account.accountName}</dd>
          {row.reference ? (
            <>
              <dt className="text-muted-foreground">Reference</dt>
              <dd>{row.reference}</dd>
            </>
          ) : null}
        </dl>

        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            <tr>
              <td className="py-2">Amount before VAT</td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(row.netAmount.toString())}
              </td>
            </tr>
            <tr>
              <td className="py-2">
                {withVat ? `VAT ${row.vatRate.toString().replace(/\.?0+$/, '')}%` : 'VAT'}
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(row.vatAmount.toString())}
              </td>
            </tr>
            <tr className="font-semibold">
              <td className="py-2">Total received</td>
              <td className="py-2 text-right tabular-nums">{formatMoney(row.amount.toString())}</td>
            </tr>
          </tbody>
        </table>

        {row.notes ? <p className="text-sm whitespace-pre-wrap">{row.notes}</p> : null}
        {isVoid && row.voidReason ? (
          <p className="text-sm text-muted-foreground print:hidden">{`Voided: ${row.voidReason}`}</p>
        ) : null}
        <p className="text-xs text-muted-foreground print:hidden">
          {`Booked to ${row.incomeAccount.accountCode} ${row.incomeAccount.accountName}. Recorded by ${row.createdBy.fullName}.`}
        </p>
      </Panel>
    </Stack>
  );
}
