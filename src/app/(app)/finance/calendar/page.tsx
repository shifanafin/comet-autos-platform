import Link from 'next/link';
import { ArrowRight, CalendarClock, ChevronRight } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import {
  getComplianceCalendar,
  type CalendarItem,
  type ItemState,
} from '@/lib/compliance/calendar';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { CompanyDatesForm } from '@/components/compliance/company-dates-form';
import { RecordFiledElsewhereButton } from '@/components/compliance/record-filed-elsewhere';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Tax & accounting calendar' };

const STATE: Record<ItemState, { label: string; tone: PillTone }> = {
  done: { label: 'Done', tone: 'success' },
  todo: { label: 'To do', tone: 'warning' },
  late: { label: 'Late', tone: 'danger' },
  upcoming: { label: 'Coming up', tone: 'info' },
  none: { label: 'Nothing to do', tone: 'neutral' },
  missing: { label: 'Needs setting up', tone: 'warning' },
};

const date = (value: string) => formatCalendarDate(value);

function ItemRow({ item }: { item: CalendarItem }) {
  const pill = STATE[item.state];
  const body = (
    <>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.title}</span>
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        </span>
        <span className="text-sm text-muted-foreground">{item.detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3 @md:flex-col @md:items-end @md:gap-1">
        {item.due ? (
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground">Due </span>
            <span className="font-medium">{date(item.due)}</span>
          </span>
        ) : null}
        {item.href && item.action ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
            {item.action}
            <ChevronRight className="size-4" />
          </span>
        ) : null}
      </span>
    </>
  );
  const row =
    'flex flex-col gap-3 px-4 py-4 @md:flex-row @md:items-center @md:justify-between sm:px-6';
  return (
    <li>
      {item.href ? (
        <Link href={item.href} className={cn(row, 'hover:bg-muted/40')}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

function ItemList({ items }: { items: CalendarItem[] }) {
  return (
    <Panel padding="none" className="@container overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <ItemRow key={item.key} item={item} />
        ))}
      </ul>
    </Panel>
  );
}

/** Plain-words answers, folded away until wanted. */
const GUIDE: { title: string; body: string[] }[] = [
  {
    title: 'VAT — what it is and what you do',
    body: [
      'You add 5% VAT to what you charge customers (output VAT) and pay 5% VAT on what you buy for the business (input VAT). Every period you pay the FTA the difference — or the FTA owes you, if you bought more than you sold.',
      'The FTA sets your periods on the VAT certificate, usually every three months. After each period ends you have 28 days to file the return (VAT201) in EmaraTax and pay. Missing either brings fines.',
      'This app prepares the figures: open the period below, check the documents behind each box, copy the boxes into EmaraTax, submit, then record it here as filed with the FTA reference, and record the payment when it is made.',
      'Keep the supplier tax invoices for everything you claim VAT back on — no tax invoice, no claim.',
    ],
  },
  {
    title: 'Corporate tax — what it is and what you do',
    body: [
      'Every UAE company, an LLC included, must register for corporate tax in EmaraTax — even if it will never pay any. Registering late brings a fine.',
      'The tax is worked out on the profit of each financial year: 0% on the first AED 375,000 of profit and 9% on the profit above it. A workshop of this size usually pays nothing, but it still files a return every year.',
      'The return and any tax are due nine months after the year ends — for a year ending 31 December, by 30 September of the next year.',
      'Small Business Relief: a company with revenue of AED 3 million or less can choose to be treated as having no taxable income, for tax periods ending on or before 31 December 2026. You choose it in the return. Check with the FTA or a tax agent whether it has been extended before relying on it for later years.',
    ],
  },
  {
    title: 'The financial year — and closing it',
    body: [
      'The financial year is the twelve months the company measures its profit for — usually 1 January to 31 December. The first year runs from when the company started to the first year end, and can be shorter or longer than twelve months.',
      'After the year ends: finish the last month (salaries, bank, depreciation), count the stock and correct the stock figure, then close the year in Year-end closing. The profit moves into retained earnings and next year starts at zero.',
      'The profit & loss and balance sheet for the closed year are what the corporate tax return, the bank and any auditor ask for.',
    ],
  },
  {
    title: 'Salaries, WPS and end-of-service',
    body: [
      'Companies registered with the Ministry of Human Resources (MOHRE) pay salaries through the Wage Protection System (WPS), using a bank or exchange house. A salary not paid within 15 days of its due date is late.',
      'End-of-service gratuity: after a year of service an employee earns 21 days of basic salary for each of the first five years, and 30 days for each year after. It is paid when they leave, so the business owes it a little more every month.',
      'Annual leave: two days a month after six months, then 30 days a year.',
    ],
  },
  {
    title: 'Every month, in order',
    body: [
      '1. Record every sale, expense and purchase as it happens, with the supplier’s tax invoice.',
      '2. Pay salaries and record the payroll.',
      '3. Match the books to the bank statement (Bank reconciliation).',
      '4. Run depreciation for the equipment.',
      '5. Close the month so nothing in it changes by mistake.',
      'Keep all records — invoices, bills, bank statements, payroll — for at least seven years.',
    ],
  },
];

export default async function ComplianceCalendarPage() {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.view')) {
    return <AccessDenied what="the tax & accounting calendar" />;
  }
  const calendar = await getComplianceCalendar(user);
  const canEdit = hasPermission(user, 'settings.edit');
  const canRecordVat = hasPermission(user, 'vat.create');
  const missing = calendar.setup.filter((item) => item.state !== 'done').length;
  const ct = calendar.corporateTax;
  const vatRows = [...calendar.vat.periods].reverse();

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance" className="text-primary hover:underline">
            Finance
          </Link>
        }
        title="Tax & accounting calendar"
        description="What the company has to do, and by when: VAT returns, corporate tax, the month's routine and the set-up. Each item checks the books, so it shows done as soon as it is."
      />

      <Section title="Coming up" description="Deadlines, soonest first.">
        {calendar.deadlines.length ? (
          <ItemList items={calendar.deadlines} />
        ) : (
          <Panel>
            <EmptyState
              icon={CalendarClock}
              title="No deadlines yet"
              description="Enter the VAT periods and the financial year below, and every return and year end shows here with its due date."
            />
          </Panel>
        )}
      </Section>

      <Section
        title={`The month's routine — ${calendar.lastMonthLabel}`}
        description="Done once a month, after the month ends."
      >
        <ItemList items={calendar.monthly} />
      </Section>

      <Section
        title="VAT returns"
        description={
          calendar.vat.configured
            ? 'Every period from the certificate. Open one to see its return.'
            : 'Enter the first VAT period from the certificate below to list every return.'
        }
      >
        {calendar.vat.configured ? (
          <Panel padding="none" className="@container overflow-hidden">
            <ul className="divide-y divide-border">
              {vatRows.map((period) =>
                // Before these books: the app has no figures for it, so the
                // row offers to record the return as filed instead of a link.
                period.beforeBooks ? (
                  <li
                    key={period.to}
                    className="flex flex-col gap-3 px-4 py-3 @md:flex-row @md:items-center @md:justify-between sm:px-6"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium tabular-nums">
                        {date(period.from)} – {date(period.to)}
                      </span>
                      <span className="text-sm text-muted-foreground">{period.status}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="text-sm tabular-nums text-muted-foreground">
                        Due {date(period.due)}
                      </span>
                      <StatusPill tone={STATE[period.state].tone}>
                        {STATE[period.state].label}
                      </StatusPill>
                      {period.netVat === null && canRecordVat ? (
                        <RecordFiledElsewhereButton from={period.from} to={period.to} />
                      ) : null}
                    </span>
                  </li>
                ) : (
                  <li key={period.to}>
                    <Link
                      href={period.href}
                      className="flex flex-col gap-2 px-4 py-3 hover:bg-muted/40 @md:flex-row @md:items-center @md:justify-between sm:px-6"
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium tabular-nums">
                          {date(period.from)} – {date(period.to)}
                        </span>
                        <span className="text-sm text-muted-foreground">{period.status}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          Due {date(period.due)}
                        </span>
                        <StatusPill tone={STATE[period.state].tone}>
                          {STATE[period.state].label}
                        </StatusPill>
                      </span>
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </Panel>
        ) : null}
      </Section>

      <Section title="Corporate tax" description="Worked out on each financial year's profit.">
        {ct ? (
          <div className="grid gap-4 @container lg:grid-cols-2">
            {[
              { label: 'This financial year', year: ct.current },
              ...(ct.ended ? [{ label: 'The last year that ended', year: ct.ended }] : []),
            ].map(({ label, year }) => (
              <Panel key={label} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">{label}</span>
                  <span className="text-lg font-semibold tabular-nums">
                    {year.start ? date(year.start) : 'Start'} – {date(year.end)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Return and any tax due by {date(year.due)}
                  </span>
                </div>
                {year.figures ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">
                      Revenue{year.end > calendar.today ? ' so far' : ''}
                    </dt>
                    <dd className="text-right tabular-nums">{formatMoney(year.figures.revenue)}</dd>
                    <dt className="text-muted-foreground">
                      Profit{year.end > calendar.today ? ' so far' : ''}
                    </dt>
                    <dd className="text-right tabular-nums">{formatMoney(year.figures.profit)}</dd>
                    <dt className="text-muted-foreground">Estimated tax (9% above AED 375,000)</dt>
                    <dd className="text-right font-semibold tabular-nums">
                      {formatMoney(year.figures.estimate)}
                    </dd>
                  </dl>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {year.figures?.reliefPossible
                    ? 'Revenue is under AED 3 million and the year ends by 31 December 2026, so Small Business Relief can be chosen in the return: no tax for the year.'
                    : 'An estimate from the books, before the adjustments the return itself makes.'}
                </p>
              </Panel>
            ))}
          </div>
        ) : (
          <Panel>
            <p className="text-sm text-muted-foreground">
              Enter the financial year below to see each year&apos;s corporate tax deadline and an
              estimate of the tax.
            </p>
          </Panel>
        )}
        {ct && !ct.registered ? (
          <p className="text-sm text-warning">
            No corporate tax registration number is recorded. Every UAE company must register in
            EmaraTax — if you have not, do it now; then enter the number below.
          </p>
        ) : null}
      </Section>

      <Section
        title="Set-up"
        description={
          missing
            ? `${missing} thing${missing === 1 ? '' : 's'} still to set up.`
            : 'Everything is set up.'
        }
      >
        <ItemList items={calendar.setup} />
      </Section>

      <Section
        title="The company's dates"
        description="Entered once, from the company's certificates. Everything above is worked out from them."
      >
        <Panel className="@container">
          {canEdit ? (
            <CompanyDatesForm dates={calendar.dates} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only someone who can change the settings can enter these.
            </p>
          )}
        </Panel>
      </Section>

      <Section title="In plain words" description="What each of these means, and what you do.">
        <Panel padding="none" className="overflow-hidden">
          <ul className="divide-y divide-border">
            {GUIDE.map((topic) => (
              <li key={topic.title}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 font-medium hover:bg-muted/40 sm:px-6 [&::-webkit-details-marker]:hidden">
                    {topic.title}
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="flex flex-col gap-3 px-4 pb-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
                    {topic.body.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Panel>
      </Section>
    </Stack>
  );
}
