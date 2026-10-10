import Link from 'next/link';
import { ArrowRight, ArrowRightLeft, CreditCard, HandCoins, TriangleAlert } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { getMoneyOverview } from '@/lib/finance/money';
import { formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { LinkButton } from '@/components/shared/link-button';

export const metadata = { title: 'Money' };

/** "AED 1,250.00", or "−AED 114.79" below zero. */
const money = (value: string) =>
  value.startsWith('-') ? `−${formatMoney(value.slice(1))}` : formatMoney(value);

/** What each kind of account is, in a line. */
const KIND_NOTE: Record<string, string> = {
  cash: 'Cash in the drawer.',
  petty: 'The separate small-cash box for little purchases.',
  bank: 'Money in the bank.',
  'card-settlements':
    'Customers paid by card; the card company has yet to pay it into the bank. Counted as money.',
  'company-card': 'What is owed on the company card. A debt — not counted as money.',
  other: 'Not counted as money until it is banked (e.g. post-dated cheques received).',
};

/** How much money the workshop has, and where it is. */
export default async function MoneyPage() {
  const user = await requireUser();
  let overview;
  try {
    overview = await getMoneyOverview(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="money" />;
    throw error;
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Cash & Bank"
        title="Money"
        description="How much money the workshop has, and where it is: the cash drawer, the petty-cash box, the bank. Every figure comes from the books, so it always agrees with the balance sheet."
        actions={
          overview.canTransfer ? (
            <>
              <LinkButton href="/finance/money/owner" size="lg" variant="outline">
                <HandCoins />
                Owner&apos;s money
              </LinkButton>
              <LinkButton href="/finance/money/transfers" size="lg">
                <ArrowRightLeft />
                Move money
              </LinkButton>
            </>
          ) : (
            <LinkButton href="/finance/money/owner" size="lg" variant="outline">
              <HandCoins />
              Owner&apos;s money
            </LinkButton>
          )
        }
      />

      <Panel className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Money now</span>
        <span className="text-3xl leading-none font-semibold tabular-nums">
          {money(overview.moneyNow)}
        </span>
        <span className="text-xs text-muted-foreground">
          Cash on hand, petty cash, bank and card payments on the way.
          {overview.hasCompanyCard
            ? ` Owed on company cards: ${money(overview.owedOnCards)}, not taken off.`
            : ''}
        </span>
      </Panel>

      {overview.groups.map((group) => (
        <Section
          key={group.kind}
          title={group.label}
          description={KIND_NOTE[group.kind]}
          action={
            group.accounts.length > 1 ? (
              <span className="text-sm font-semibold tabular-nums">{money(group.total)}</span>
            ) : undefined
          }
        >
          <Panel padding="none">
            <ul className="divide-y divide-border">
              {group.accounts.map((account) => (
                <li key={account.id}>
                  <Link
                    href={`/finance/money/${account.id}`}
                    className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 sm:px-6"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{account.name}</span>
                      <span className="text-xs text-muted-foreground">{account.code}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span
                        className={
                          account.belowZero
                            ? 'font-semibold text-warning tabular-nums'
                            : 'font-semibold tabular-nums'
                        }
                      >
                        {money(account.balance)}
                      </span>
                      <ArrowRight className="size-4 text-muted-foreground" />
                    </span>
                  </Link>
                  {account.belowZero ? (
                    <p className="flex items-start gap-2 border-t border-warning/30 bg-warning/5 px-4 py-2.5 text-xs text-warning sm:px-6">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      Below zero: more has been paid out of it than was ever recorded going in. What
                      it held at the start (its opening balance), or the money put into it, has not
                      been entered yet.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      ))}

      {!overview.hasCompanyCard ? (
        <Section title="Company card">
          <Panel className="flex items-start gap-3 text-sm">
            <CreditCard className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Visa ending 6077: waiting to be set up</p>
              <p className="text-muted-foreground">
                Once the card statement confirms what kind of card it is, it is added here. A debit
                card takes money straight from the bank, so it is paid from the bank account. A
                credit card is money owed to the card company, so it gets an account of its own and
                its balance is shown as owed, not as money.
              </p>
            </div>
          </Panel>
        </Section>
      ) : null}
    </Stack>
  );
}
