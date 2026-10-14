import Link from 'next/link';
import { Landmark } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { listReconciliationAccounts } from '@/lib/accounting/reconciliation';
import { formatCalendarDate, formatMoney, localDateString } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';
import { StartReconciliationForm } from '@/components/accounting/reconciliation-controls';
import { StatementUpload } from '@/components/accounting/statement-upload';
import { savedColumns } from '@/lib/accounting/statement-file';

export const metadata = { title: 'Bank reconciliation' };

const money = (value: string) =>
  value.startsWith('-') ? `−${formatMoney(value.slice(1))}` : formatMoney(value);

export default async function BankReconciliationPage() {
  const user = await requireUser();
  let accounts;
  try {
    accounts = await listReconciliationAccounts(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="bank reconciliation" />;
    throw error;
  }
  const canEdit = hasPermission(user, 'accounting.edit');
  const startable = accounts.filter((account) => account.isActive && !account.inProgress);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Cash & Bank"
        title="Bank reconciliation"
        description="Prove each bank, cash and card account against its statement: tick every line that appears on the statement until the cleared balance agrees with it. What is left unticked is timing — cheques not yet presented, deposits not yet credited."
      />

      {accounts.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No bank or cash accounts"
          description="Mark an account as a cash, bank or card account in the chart of accounts."
        />
      ) : (
        <Section title="Accounts">
          <Panel padding="none">
            <ul className="divide-y divide-border">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">
                      <span className="font-mono text-xs text-muted-foreground">
                        {account.accountCode}
                      </span>{' '}
                      {account.accountName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {`Balance in the books ${money(account.bookBalance)} · `}
                      {account.lastCompleted
                        ? `reconciled to ${formatCalendarDate(account.lastCompleted.statementDate)}`
                        : 'never reconciled'}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {account.inProgress ? (
                      <Link
                        href={`/finance/bank-reconciliation/${account.inProgress.id}`}
                        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
                      >
                        <StatusPill tone="warning">In progress</StatusPill>
                        {`To ${formatCalendarDate(account.inProgress.statementDate)}`}
                      </Link>
                    ) : null}
                    {account.bankReconciliations
                      .filter((rec) => rec.status === 'COMPLETED')
                      .slice(0, 3)
                      .map((rec) => (
                        <Link
                          key={rec.id}
                          href={`/finance/bank-reconciliation/${rec.id}`}
                          className="text-xs text-primary hover:underline"
                        >
                          {formatCalendarDate(rec.statementDate)}
                        </Link>
                      ))}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      )}

      {canEdit && startable.length > 0 ? (
        <>
          <Section
            title="Upload a statement"
            description="Download the statement from online banking (or the card company’s settlement report) as CSV and upload it. Its lines are matched to the books for you; you confirm the rest."
          >
            <Panel>
              <StatementUpload
                accounts={startable.map((account) => ({
                  id: account.id,
                  label: `${account.accountCode} ${account.accountName}`,
                  columns: savedColumns(account.statementColumns),
                }))}
              />
            </Panel>
          </Section>

          <Section
            title="Or enter the balance by hand"
            description="For the cash box — count the cash on the last day: that count is the balance — or a statement you have only on paper. Then tick each line yourself."
          >
            <Panel>
              <StartReconciliationForm
                today={localDateString()}
                accounts={startable.map((account) => ({
                  id: account.id,
                  label: `${account.accountCode} ${account.accountName}`,
                }))}
              />
            </Panel>
          </Section>
        </>
      ) : null}

      <Section title="Each month">
        <Panel>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              In the first week of the month, reconcile last month for every account: upload the
              bank statement and the card company’s report, and enter the cash count.
            </li>
            <li>
              Only the closing balance on the last day is needed. The opening balance is always the
              last reconciliation’s closing balance — never typed.
            </li>
            <li>
              Anything on the statement but not in the books (bank charges, interest): record it,
              then match it.
            </li>
            <li>
              When the difference is nil, complete the reconciliation. Then close the month in
              Accounting — and file VAT for the quarter once its last month is reconciled.
            </li>
          </ol>
        </Panel>
      </Section>
    </Stack>
  );
}
