import Link from 'next/link';
import { CreditCard, FileSignature, Wrench } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { listPaymentVouchers, type PaymentVoucherRow } from '@/lib/finance/payment-vouchers';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { Pagination } from '@/components/shared/pagination';
import { StatusPill } from '@/components/shared/status-pill';
import { loadPage, pageFrom } from '@/lib/pagination';

export const metadata = { title: 'Payment vouchers' };

const KIND_LABEL = { CARD_COLLECTION: 'Card money paid over', WORK: 'Outside work' } as const;

/** The voucher's pill: paid, still owed to them, or void. */
function Status({ status }: { status: PaymentVoucherRow['status'] }) {
  return status === 'VOID' ? (
    <StatusPill tone="neutral">Void</StatusPill>
  ) : status === 'OWED' ? (
    <StatusPill tone="warning">Owed to them</StatusPill>
  ) : (
    <StatusPill tone="success">Paid</StatusPill>
  );
}

/** Money paid out on signed vouchers, and card money still owed to people. */
export default async function PaymentVouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let list;
  let info;
  try {
    ({ result: list, info } = await loadPage(pageFrom(params.page), (skip, take) =>
      listPaymentVouchers(user, take, skip),
    ));
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="payment vouchers" />;
    throw error;
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Suppliers & Bills"
        title="Payment vouchers"
        description="Money paid out to someone, on a voucher they sign: card payments taken on our machine for someone else (paid over less the bank's fee), and outside work such as a mechanic called in."
        actions={
          list.canCreate ? (
            <span className="flex flex-wrap items-center gap-2">
              <LinkButton href="/finance/payment-vouchers/new?kind=card" size="lg">
                <CreditCard />
                Card money for someone
              </LinkButton>
              <LinkButton href="/finance/payment-vouchers/new?kind=work" variant="outline" size="lg">
                <Wrench />
                Outside work
              </LinkButton>
            </span>
          ) : null
        }
      />

      {list.owed.length ? (
        <Section
          title="Owed to people"
          description={`Card money collected for them and not paid over yet: ${formatMoney(list.owedTotal)} in all, before the bank's fee.`}
        >
          <Panel padding="none" className="overflow-hidden">
            <ul className="divide-y divide-border">
              {list.owed.map((voucher) => (
                <li key={voucher.id}>
                  <Link
                    href={`/finance/payment-vouchers/${voucher.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40 sm:px-6"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{voucher.payeeName}</span>
                      <span className="text-xs text-muted-foreground">
                        {`${voucher.voucherNumber} · collected ${formatCalendarDate(voucher.collectedOn!)}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="font-semibold tabular-nums">
                        {formatMoney(voucher.collectedAmount!.toString())}
                      </span>
                      <span className="text-sm font-medium text-primary">Pay over →</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      ) : null}

      <Section title="Vouchers">
        {list.vouchers.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title="No payment vouchers yet"
            description="When you pay someone — card money collected for them, or an outside mechanic — the voucher they sign is listed here."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-180 text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="w-28 px-4 py-3 pl-6">Date</th>
                    <th className="px-2 py-3">Paid to</th>
                    <th className="w-44 px-2 py-3">Kind</th>
                    <th className="w-32 px-2 py-3 text-right">Amount</th>
                    <th className="w-32 px-4 py-3 pr-6">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.vouchers.map((voucher) => {
                    const isVoid = voucher.status === 'VOID';
                    const shown = voucher.amount ?? voucher.collectedAmount;
                    return (
                      <tr key={voucher.id} className={isVoid ? 'text-muted-foreground' : undefined}>
                        <td className="px-4 py-3 pl-6 tabular-nums whitespace-nowrap">
                          {formatCalendarDate((voucher.paidOn ?? voucher.collectedOn)!)}
                        </td>
                        <td className="px-2 py-3">
                          <Link
                            href={`/finance/payment-vouchers/${voucher.id}`}
                            className="font-medium hover:underline"
                          >
                            {voucher.payeeName}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {`${voucher.voucherNumber} · ${voucher.description}`}
                          </span>
                          {isVoid && voucher.voidReason ? (
                            <span className="block text-xs">{`Voided: ${voucher.voidReason}`}</span>
                          ) : null}
                        </td>
                        <td className="px-2 py-3">{KIND_LABEL[voucher.kind]}</td>
                        <td
                          className={
                            isVoid
                              ? 'px-2 py-3 text-right tabular-nums line-through'
                              : 'px-2 py-3 text-right font-semibold tabular-nums'
                          }
                        >
                          {shown ? formatMoney(shown.toString()) : '—'}
                        </td>
                        <td className="px-4 py-3 pr-6">
                          <Status status={voucher.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              info={info}
              basePath="/finance/payment-vouchers"
              params={params}
              noun="vouchers"
            />
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
