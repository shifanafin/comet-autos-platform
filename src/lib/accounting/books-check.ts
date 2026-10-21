import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { postingState, syncPosting, type PostedSource, type PostingState } from '@/lib/accounting/journal';
import { POSTING_RULES } from '@/lib/accounting/postings';
import { sourceLinks } from '@/lib/accounting/reports';

/*
 * The books check: is every transaction in the books, exactly as its record
 * says? For every record the posting rules book from — invoices, payments,
 * expenses, stock movements, payroll, VAT returns, credit notes, assets,
 * transfers, advances, owner's money, vouchers… — the entry its rule calls
 * for is compared with the one standing (journal.ts postingState):
 *
 *   missing   the record should be in the books and has no entry
 *   differs   it has one, but no longer what the record says (amount,
 *             accounts or date changed after it was booked)
 *   orphan    an entry still stands though its record no longer calls for
 *             one (voided, cancelled, deleted)
 *
 * Every journal entry booked from a record is looked at too, so an entry
 * left behind by a record deleted outside the app is found.
 *
 * Kept on purpose, never "fixed": the stock written off on 5–6 Oct 2026 as
 * historical consumption — parts fitted to customers' cars before stock was
 * tracked, each costed by its own entry (an invoice skips a fitting that has
 * one: postings.ts postInvoice). Re-booking them by today's rule would move
 * their cost between months and accounts, or cost a part twice. Entries made by
 * hand, the opening balances and the year-end close have no record to
 * follow and are not checked.
 *
 * "Bring into step" runs the app's own rule on each one found (syncPosting):
 * booked, corrected in place while its period is open, or reversed once it
 * is closed — never a figure invented here.
 */

type Client = Prisma.TransactionClient;

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

/** Every record of each kind the books post from (the rule decides whether it counts). */
const RECORDS: Record<PostedSource, (organizationId: string) => Promise<string[]>> = {
  INVOICE: (o) => prisma.invoice.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  INVOICE_DISCOUNT: (o) =>
    prisma.invoice.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PAYMENT: (o) => prisma.payment.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  EXPENSE: (o) => prisma.expense.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  STOCK_MOVEMENT: (o) =>
    prisma.inventoryTransaction.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  SUPPLIER_PAYMENT: (o) =>
    prisma.supplierPayment.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PAYROLL: (o) => prisma.payroll.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PAYROLL_PAYMENT: (o) =>
    prisma.payroll.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  VAT_FILING: (o) => prisma.vatFiling.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  VAT_PAYMENT: (o) => prisma.vatFiling.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CREDIT_NOTE: (o) => prisma.creditNote.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CREDIT_NOTE_REFUND: (o) =>
    prisma.creditNote.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  FIXED_ASSET: (o) => prisma.fixedAsset.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  ASSET_DISPOSAL: (o) =>
    prisma.fixedAsset.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  DEPRECIATION: (o) =>
    prisma.assetDepreciation.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  OWNER_REIMBURSEMENT: (o) =>
    prisma.ownerReimbursement.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  MONEY_TRANSFER: (o) =>
    prisma.moneyTransfer.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CUSTOMER_ADVANCE: (o) =>
    prisma.customerAdvance.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CUSTOMER_ADVANCE_ALLOCATION: (o) =>
    prisma.customerAdvanceAllocation.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CUSTOMER_ADVANCE_REFUND: (o) =>
    prisma.customerAdvanceRefund.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PURCHASE_ROUNDING: (o) => prisma.purchase.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PURCHASE_BILL: (o) => prisma.purchase.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  OWNER_MONEY: (o) => prisma.ownerMoney.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  CARD_COLLECTION: (o) =>
    prisma.paymentVoucher.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PAYMENT_VOUCHER: (o) =>
    prisma.paymentVoucher.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  PRIOR_PERIOD: (o) =>
    prisma.priorPeriodSummary.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  FINAL_SETTLEMENT: (o) =>
    prisma.finalSettlement.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
  FINAL_SETTLEMENT_PAYMENT: (o) =>
    prisma.finalSettlement.findMany({ where: { organizationId: o }, select: { id: true } }).then(ids),
};

export const SOURCE_LABEL: Record<PostedSource, string> = {
  INVOICE: 'Invoices',
  INVOICE_DISCOUNT: 'Discounts after an invoice',
  PAYMENT: 'Payments received',
  EXPENSE: 'Expenses',
  STOCK_MOVEMENT: 'Stock movements',
  SUPPLIER_PAYMENT: 'Supplier payments',
  PAYROLL: 'Payroll',
  PAYROLL_PAYMENT: 'Payroll payments',
  VAT_FILING: 'VAT returns',
  VAT_PAYMENT: 'VAT payments',
  CREDIT_NOTE: 'Credit notes',
  CREDIT_NOTE_REFUND: 'Credit note refunds',
  FIXED_ASSET: 'Fixed assets',
  ASSET_DISPOSAL: 'Asset disposals',
  DEPRECIATION: 'Depreciation',
  OWNER_REIMBURSEMENT: 'Owner reimbursements',
  MONEY_TRANSFER: 'Money transfers',
  CUSTOMER_ADVANCE: 'Customer advances',
  CUSTOMER_ADVANCE_ALLOCATION: 'Advances applied',
  CUSTOMER_ADVANCE_REFUND: 'Advances refunded',
  PURCHASE_ROUNDING: 'Purchase round-offs',
  PURCHASE_BILL: 'Supplier bills matched later',
  OWNER_MONEY: "Owner's money",
  CARD_COLLECTION: 'Card money collected for others',
  PAYMENT_VOUCHER: 'Payment vouchers',
  PRIOR_PERIOD: 'Months before these books',
  FINAL_SETTLEMENT: 'Final settlements',
  FINAL_SETTLEMENT_PAYMENT: 'Final settlement payments',
};

export const STATE_LABEL: Record<Exclude<PostingState, 'ok'>, string> = {
  missing: 'Not in the books',
  differs: 'Entry no longer matches its record',
  orphan: 'Entry stands, but its record no longer calls for one',
};

/** Runs `work` over `items`, `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  }
  return results;
}

export interface BooksProblem {
  source: PostedSource;
  sourceId: string;
  state: Exclude<PostingState, 'ok'>;
}

/** Why a stock movement's own entry is kept as booked, or null when it is not one of those. */
async function keptOnPurpose(organizationId: string, problems: BooksProblem[]) {
  const movementIds = problems.filter((row) => row.source === 'STOCK_MOVEMENT').map((row) => row.sourceId);
  if (!movementIds.length) return new Map<string, string>();
  const movements = await prisma.inventoryTransaction.findMany({
    where: { organizationId, id: { in: movementIds } },
    select: { id: true, transactionType: true, note: true },
  });
  const kept = new Map<string, string>();
  for (const movement of movements) {
    if (movement.transactionType === 'JOB_CONSUMPTION') {
      kept.set(movement.id, 'A part fitted on an old job, costed on its own entry; its invoice skips it.');
    } else if (movement.transactionType === 'ADJUSTMENT' && /^historical (job )?consumption/i.test(movement.note ?? '')) {
      kept.set(movement.id, 'Old stock used on customers’ cars, written off to cost of sales on its own entry.');
    }
  }
  return kept;
}

/**
 * Cash, petty cash and bank accounts that stood below zero at the end of any
 * day. A drawer can't hold less than nothing, so a payment was booked before
 * the money it came from — someone paid personally, the money was put in from
 * outside the books, or a date is wrong. Card settlements are left out: they
 * clear on the bank's timing. (A real bank overdraft would show here too.)
 */
async function moneyBelowZero(organizationId: string) {
  const rows = await prisma.$queryRaw<
    { id: string; code: string; name: string; first_day: string; lowest: string; lowest_day: string }[]
  >`
    WITH daily AS (
      SELECT l.chart_of_account_id AS account_id, e.entry_date AS day,
             SUM(l.debit_amount - l.credit_amount) AS movement
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN chart_of_accounts a ON a.id = l.chart_of_account_id
      WHERE l.organization_id = ${organizationId}::uuid
        AND a.is_payment_account
        AND a.role IS DISTINCT FROM 'CARD_CLEARING'
      GROUP BY 1, 2
    ), running AS (
      SELECT account_id, day, SUM(movement) OVER (PARTITION BY account_id ORDER BY day) AS balance
      FROM daily
    ), lowest AS (
      SELECT DISTINCT ON (account_id) account_id, day, balance
      FROM running WHERE balance < 0 ORDER BY account_id, balance, day
    )
    SELECT a.id, a.account_code AS code, a.account_name AS name,
           to_char(MIN(r.day), 'YYYY-MM-DD') AS first_day,
           lowest.balance::text AS lowest, to_char(lowest.day, 'YYYY-MM-DD') AS lowest_day
    FROM running r
    JOIN lowest ON lowest.account_id = r.account_id
    JOIN chart_of_accounts a ON a.id = r.account_id
    WHERE r.balance < 0
    GROUP BY a.id, a.account_code, a.account_name, lowest.balance, lowest.day
    ORDER BY a.account_code`;
  return rows.map((row) => ({
    accountId: row.id,
    code: row.code,
    name: row.name,
    firstDay: row.first_day,
    lowest: row.lowest,
    lowestDay: row.lowest_day,
  }));
}

/** Every record and booked entry compared; what is out of step, by kind. */
export async function checkBooks(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;
  const client = prisma as unknown as Client;
  const sources = Object.keys(POSTING_RULES) as PostedSource[];
  const booked = await prisma.journalEntry.findMany({
    where: { organizationId, sourceType: { in: sources }, sourceId: { not: null } },
    select: { sourceType: true, sourceId: true },
  });

  const summary: { source: PostedSource; label: string; checked: number; problems: number }[] = [];
  const problems: BooksProblem[] = [];
  for (const source of sources) {
    const records = await RECORDS[source](organizationId);
    const all = [
      ...new Set([
        ...records,
        ...booked.filter((row) => row.sourceType === source).map((row) => row.sourceId!),
      ]),
    ];
    const states = await inBatches(all, 8, async (sourceId) => ({
      sourceId,
      state: await postingState(client, organizationId, source, sourceId),
    }));
    const found = states.filter(
      (row): row is { sourceId: string; state: Exclude<PostingState, 'ok'> } => row.state !== 'ok',
    );
    problems.push(...found.map((row) => ({ source, ...row })));
    summary.push({ source, label: SOURCE_LABEL[source], checked: all.length, problems: found.length });
  }
  // The historical stock entries are kept as booked: not problems.
  const kept = await keptOnPurpose(organizationId, problems);
  const keptRows = problems
    .filter((row) => row.source === 'STOCK_MOVEMENT' && kept.has(row.sourceId))
    .map((row) => ({ ...row, why: kept.get(row.sourceId)! }));
  const real = problems.filter((row) => !(row.source === 'STOCK_MOVEMENT' && kept.has(row.sourceId)));
  for (const row of summary) {
    row.problems = real.filter((problem) => problem.source === row.source).length;
  }
  // What each one is, in words, with its entry and a link to its record.
  const listed = [...real, ...keptRows];
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId,
      OR: listed.map((row) => ({ sourceType: row.source, sourceId: row.sourceId })),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, entryNumber: true, entryDate: true, description: true, sourceType: true, sourceId: true },
  });
  const link = await sourceLinks(
    organizationId,
    listed.map((row) => ({ sourceType: row.source, sourceId: row.sourceId })),
  );
  const describe = <T extends BooksProblem>(row: T) => {
    const entry = entries.find((e) => e.sourceType === row.source && e.sourceId === row.sourceId);
    return {
      ...row,
      kind: SOURCE_LABEL[row.source],
      entryId: entry?.id ?? null,
      entryNumber: entry?.entryNumber ?? null,
      entryDate: entry?.entryDate ?? null,
      description: entry?.description ?? `${SOURCE_LABEL[row.source]} — not booked yet`,
      href: link(row.source, row.sourceId).href,
    };
  };
  return {
    checkedAt: new Date(),
    checked: summary.reduce((sum, row) => sum + row.checked, 0),
    summary: summary.filter((row) => row.checked > 0),
    problems: real.map(describe),
    kept: keptRows.map(describe),
    /** Money accounts that stood below zero on some day: each needs its missing source found. */
    belowZero: await moneyBelowZero(organizationId),
  };
}

export type BooksCheck = Awaited<ReturnType<typeof checkBooks>>;

/**
 * Brings what the check found into step by the app's own rule, one record
 * at a time (each in its own transaction). A record that can't be — its
 * period closed in a way the rule refuses, say — is reported, not forced.
 */
export async function bringBooksIntoStep(
  user: AuthenticatedUser,
  only?: { source: PostedSource; sourceId: string },
) {
  requirePermission(user, 'accounting.edit');
  const found = (await checkBooks(user)).problems;
  const problems = only
    ? found.filter((row) => row.source === only.source && row.sourceId === only.sourceId)
    : found;
  let fixed = 0;
  const failed: (BooksProblem & { why: string })[] = [];
  for (const problem of problems) {
    try {
      await prisma.$transaction(
        (tx) => syncPosting(tx, user.organizationId, problem.source, problem.sourceId, user.id),
        { timeout: 60_000 },
      );
      fixed += 1;
    } catch (error) {
      failed.push({ ...problem, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { fixed, failed };
}
