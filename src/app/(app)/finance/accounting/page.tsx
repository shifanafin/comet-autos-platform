import Link from 'next/link';
import {
  BookOpen,
  BookText,
  Info,
  Landmark,
  NotebookPen,
  Plus,
  Scale,
  Sheet,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { listAccounts, type AccountGroups } from '@/lib/finance/accounting';
import { getCashFlowStatement } from '@/lib/accounting/cash-flow';
import { CashFlowView } from '@/components/accounting/cash-flow-view';
import {
  getAccountChoices,
  getAccountLedger,
  getBalanceSheet,
  getLedgerProfitAndLoss,
  getTrialBalance,
  listJournal,
} from '@/lib/accounting/reports';
import { countUnbooked } from '@/lib/accounting/entries';
import { booksClosedThrough } from '@/lib/accounting/periods';
import { prisma } from '@/lib/prisma';
import { formatCalendarDate, formatDate, localDateString } from '@/lib/format';
import { LinkButton } from '@/components/shared/link-button';
import { Pagination } from '@/components/shared/pagination';
import { loadPage, pageFrom } from '@/lib/pagination';
import {
  AccountLedgerView,
  BalanceSheetView,
  JournalView,
  LedgerProfitView,
  TrialBalanceView,
} from '@/components/accounting/ledger-views';
import {
  AccountPicker,
  AddStandardAccountsButton,
  BookExistingButton,
  CloseBooksPanel,
} from '@/components/accounting/books-controls';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { InlineForm } from '@/components/shared/inline-form';
import { StatusPill } from '@/components/shared/status-pill';
import { SearchField } from '@/components/shared/search-field';
import { EmptyState } from '@/components/shared/empty-state';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { EditAccountButton, NewAccountForm } from '@/components/finance/account-form';
import { fixedSubLedger, subLedgerOf } from '@/lib/accounting/sub-ledger';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type View = 'profit' | 'balance' | 'trial' | 'ledger' | 'journal' | 'cash' | 'accounts';

const TABS: { key: View; label: string; icon: typeof Scale }[] = [
  { key: 'accounts', label: 'Chart of accounts', icon: BookOpen },
  { key: 'journal', label: 'Journal entries', icon: NotebookPen },
  { key: 'ledger', label: 'General ledger', icon: BookText },
  { key: 'trial', label: 'Trial balance', icon: Sheet },
  { key: 'profit', label: 'Profit & loss', icon: TrendingUp },
  { key: 'balance', label: 'Balance sheet', icon: Scale },
  { key: 'cash', label: 'Cash flow', icon: WalletCards },
];

const VIEWS = TABS.map((tab) => tab.key);
/** Views that cover a period; the others show a position on one date. */
const PERIOD_VIEWS: View[] = ['profit', 'ledger', 'journal', 'cash'];
/** The financial statements: Reports → View. The rest is Accounts → View. */
const STATEMENT_VIEWS: View[] = ['profit', 'balance', 'trial', 'cash'];

/** Picks the date a balance is shown on — a plain GET form, no script needed. */
function AsOfPicker({ view, asOf }: { view: View; asOf: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="view" value={view} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">As on</span>
        <input
          type="date"
          name="asOf"
          defaultValue={asOf}
          max={localDateString()}
          className="h-10 rounded-lg border border-input bg-card px-3"
        />
      </label>
      <button
        type="submit"
        className="h-10 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
      >
        Show
      </button>
    </form>
  );
}

const PRESETS = ['month', 'last-month', 'quarter', 'last-quarter', 'year'] as const;

function Tabs({ active, search }: { active: View; search: string }) {
  return (
    <nav
      className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1"
      aria-label="Accounting"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={`/finance/accounting?view=${tab.key}${search}`}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors',
              current
                ? 'bg-foreground text-background'
                : 'text-foreground/70 hover:bg-muted active:bg-muted',
            )}
          >
            <Icon className="size-4" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountsView({
  groups,
  canEdit,
  query,
}: {
  groups: AccountGroups;
  canEdit: boolean;
  query: string;
}) {
  // While searching, only the groups with a match; otherwise every group.
  const shown = query ? groups.filter((group) => group.accounts.length > 0) : groups;
  return (
    <Stack gap="xl">
      {canEdit ? (
        <Panel padding="none" className="overflow-hidden">
          <InlineForm
            label="Add an account"
            hint="A new expense category, or an income, asset, liability or equity account."
            icon={<Landmark className="size-4" />}
          >
            <NewAccountForm />
          </InlineForm>
        </Panel>
      ) : null}
      {canEdit ? <AddStandardAccountsButton /> : null}
      <SearchField
        initialQuery={query}
        placeholder="Search by account code or name"
        keep={{ view: 'accounts' }}
      />
      {query && shown.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={`No account matches “${query}”`}
          description="Try part of the code, like 40, or a word from the name, like cash."
        />
      ) : null}
      {shown.map((group) => (
        <Section key={group.type} title={group.label}>
          {group.accounts.length === 0 ? (
            <Panel>
              <p className="text-sm text-muted-foreground">
                No {group.label.toLowerCase()} accounts.
              </p>
            </Panel>
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <ul className="divide-y divide-border">
                {group.accounts.map((account) => (
                  <li
                    key={account.id}
                    className={cn(
                      'flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6',
                      !account.isActive && 'text-muted-foreground',
                    )}
                  >
                    <span className="w-16 shrink-0 font-mono text-xs">{account.accountCode}</span>
                    <span className="min-w-0 flex-1 text-sm">{account.accountName}</span>
                    {account.role ? <StatusPill tone="info">System</StatusPill> : null}
                    {account.isPaymentAccount ? (
                      <StatusPill tone="success">Money account</StatusPill>
                    ) : null}
                    {subLedgerOf(account) ? (
                      <StatusPill tone="neutral">
                        {subLedgerOf(account) === 'CUSTOMER' ? 'Per customer' : 'Per supplier'}
                      </StatusPill>
                    ) : null}
                    {account.isActive ? null : <StatusPill tone="neutral">Retired</StatusPill>}
                    {account._count.journalEntryLines ? (
                      <Link
                        href={`/finance/accounting?view=ledger&account=${account.id}`}
                        className="text-xs text-primary tabular-nums hover:underline"
                      >
                        Ledger
                      </Link>
                    ) : null}
                    {account._count.expenses ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {account._count.expenses} expense{account._count.expenses === 1 ? '' : 's'}
                      </span>
                    ) : null}
                    {canEdit ? (
                      <EditAccountButton
                        account={{
                          id: account.id,
                          accountCode: account.accountCode,
                          accountName: account.accountName,
                          accountType: account.accountType,
                          isActive: account.isActive,
                          isPaymentAccount: account.isPaymentAccount,
                          system: account.role !== null,
                          subLedger: subLedgerOf(account),
                          subLedgerFixed:
                            fixedSubLedger(account.role) || account._count.journalEntryLines > 0,
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </Section>
      ))}
    </Stack>
  );
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    period?: string;
    from?: string;
    to?: string;
    asOf?: string;
    account?: string;
    source?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const user = await requireUser();
  // The statements are Reports; the ledger, journal and chart are Accounts.
  const canSeeAccounts = hasPermission(user, 'accounting.view');
  const canSeeReports = hasPermission(user, 'reports.view');
  if (!canSeeAccounts && !canSeeReports) return <AccessDenied what="the accounts" />;
  const canPost = hasPermission(user, 'accounting.create');
  const canEdit = hasPermission(user, 'accounting.edit');
  const canReverse = hasPermission(user, 'accounting.delete');
  const canApprove = hasPermission(user, 'accounting.approve');
  const params = await searchParams;
  const view: View =
    VIEWS.find((key) => key === params.view) ?? (canSeeReports ? 'profit' : 'journal');
  if (!(STATEMENT_VIEWS.includes(view) ? canSeeReports : canSeeAccounts)) {
    return (
      <AccessDenied
        what={STATEMENT_VIEWS.includes(view) ? 'the financial statements' : 'the ledger'}
      />
    );
  }
  const periodInput = { period: params.period, from: params.from, to: params.to };
  // Switching tab keeps the period chosen.
  const search = new URLSearchParams(
    Object.entries(periodInput).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  const tail = search ? `&${search}` : '';

  const [unbooked, closedThrough] = await Promise.all([
    canSeeAccounts ? countUnbooked(user) : 0,
    booksClosedThrough(prisma, user.organizationId),
  ]);
  const choices = view === 'ledger' ? await getAccountChoices(user) : null;
  const accountId = view === 'ledger' ? (params.account ?? choices?.all[0]?.id ?? null) : null;

  const profit = view === 'profit' ? await getLedgerProfitAndLoss(user, periodInput) : null;
  const balance = view === 'balance' ? await getBalanceSheet(user, { asOf: params.asOf }) : null;
  const trial = view === 'trial' ? await getTrialBalance(user, { asOf: params.asOf }) : null;
  const ledger = accountId ? await getAccountLedger(user, accountId, periodInput) : null;
  const journalPage =
    view === 'journal'
      ? await loadPage(pageFrom(params.page), (skip, take) =>
          listJournal(user, { ...periodInput, source: params.source }, take, skip),
        )
      : null;
  const journal = journalPage?.result ?? null;
  const cash = view === 'cash' ? await getCashFlowStatement(user, periodInput) : null;
  const accountQuery = (params.q ?? '').trim();
  const accounts = view === 'accounts' ? await listAccounts(user, { q: accountQuery }) : null;
  const period = profit?.period ?? ledger?.period ?? journal?.period ?? cash?.period ?? null;
  const asOf = balance?.asOf ?? trial?.asOf ?? null;
  const intro =
    'Double-entry books kept automatically from invoices, payments, expenses, stock and payroll.';

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Accounting"
        title="Accounting"
        description={
          period
            ? `From ${formatDate(period.from)} to ${formatDate(period.to)}. ${intro}`
            : asOf
              ? `On ${formatDate(asOf)}. ${intro}`
              : 'The accounts every amount is booked to.'
        }
        actions={
          canPost ? (
            <LinkButton href="/finance/accounting/journal/new" size="lg">
              <Plus />
              Journal entry
            </LinkButton>
          ) : undefined
        }
      />

      {unbooked > 0 ? (
        <Panel className="flex flex-wrap items-center justify-between gap-4 border-warning/40 bg-warning/5">
          <p className="flex items-start gap-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>
                {unbooked} record{unbooked === 1 ? ' is' : 's are'} not in the books yet
              </strong>{' '}
              — kept before the books existed. Book them once so every statement is complete. The
              records themselves don&apos;t change.
            </span>
          </p>
          {canApprove ? <BookExistingButton count={unbooked} /> : null}
        </Panel>
      ) : null}

      <Tabs active={view} search={tail} />

      {PERIOD_VIEWS.includes(view) && period ? (
        <FinancePeriodPicker
          period={period}
          basePath="/finance/accounting"
          presets={[...PRESETS]}
        />
      ) : null}
      {asOf ? <AsOfPicker view={view} asOf={asOf} /> : null}

      {profit ? <LedgerProfitView data={profit} search={tail} /> : null}
      {balance ? <BalanceSheetView data={balance} search={tail} /> : null}
      {trial ? <TrialBalanceView data={trial} search={tail} /> : null}
      {view === 'ledger' && choices ? (
        <Stack gap="xl">
          <AccountPicker accounts={choices.all} value={accountId} />
          {ledger ? <AccountLedgerView data={ledger} /> : null}
        </Stack>
      ) : null}
      {journal ? (
        <Stack gap="xl">
          <JournalView data={journal} canEdit={canReverse} />
          {journalPage ? (
            <Pagination
              info={journalPage.info}
              basePath="/finance/accounting"
              params={params}
              noun="entries"
              className="rounded-xl border border-border bg-card"
            />
          ) : null}
          <Section
            title="Closing the books"
            description={
              closedThrough
                ? `Closed through ${formatCalendarDate(closedThrough)}.`
                : 'Every period is open.'
            }
          >
            <Panel>
              {canApprove ? (
                <CloseBooksPanel
                  closedThrough={closedThrough ? closedThrough.toISOString().slice(0, 10) : null}
                  today={localDateString()}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only someone who manages the accounts can close or reopen a period.
                </p>
              )}
            </Panel>
          </Section>
        </Stack>
      ) : null}
      {cash ? <CashFlowView data={cash} /> : null}
      {accounts ? <AccountsView groups={accounts} canEdit={canEdit} query={accountQuery} /> : null}
    </Stack>
  );
}
