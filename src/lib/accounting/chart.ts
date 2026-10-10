import type { Prisma } from '@/generated/prisma/client';
import type { AccountRole, AccountType, PaymentMethod } from '@/generated/prisma/enums';
import { DomainError } from '@/lib/errors';

/*
 * The chart of accounts the books are kept in — a standard chart for a UAE
 * vehicle workshop.
 *
 * Automatic postings (lib/accounting/postings.ts) never look an account up
 * by code or name: they use the account holding a *role* — receivables, VAT
 * payable, parts sales and so on. So a workshop can rename or renumber any
 * account, and add its own, without breaking the books.
 *
 * The rest of the standard chart has no role: it is there for the
 * accountant's own entries (fixed assets and depreciation, corporate tax)
 * and for filing expenses in the usual categories.
 *
 * Numbering (the usual UAE layout; cost of sales is 5000–5099):
 *   1000 assets · 2000 liabilities · 3000 equity · 4000 income
 *   5000 cost of sales · 5100–5990 operating expenses
 *
 * Every workshop gets the whole chart the first time anything is booked.
 * An account already using a code, of the same kind, is adopted rather than
 * duplicated; otherwise a system account takes the next free code and a
 * standard one is skipped.
 */

interface ChartAccount {
  code: string;
  name: string;
  type: AccountType;
  /** Money can be received into or paid from it. */
  payment?: boolean;
}

interface SystemAccount extends ChartAccount {
  role: AccountRole;
}

/** The accounts the system books to, in chart order. */
export const SYSTEM_ACCOUNTS: SystemAccount[] = [
  { role: 'CASH', code: '1000', name: 'Cash on hand', type: 'ASSET', payment: true },
  { role: 'BANK', code: '1010', name: 'Bank — current account', type: 'ASSET', payment: true },
  {
    role: 'CARD_CLEARING',
    code: '1020',
    name: 'Card settlements receivable',
    type: 'ASSET',
    payment: true,
  },
  { role: 'ACCOUNTS_RECEIVABLE', code: '1100', name: 'Trade receivables', type: 'ASSET' },
  { role: 'INVENTORY', code: '1200', name: 'Inventory — spare parts', type: 'ASSET' },
  { role: 'VAT_INPUT', code: '1300', name: 'Input VAT recoverable', type: 'ASSET' },
  // VAT on parts received before the supplier's tax invoice: claimable only
  // once the bill is in hand, so it waits here until the purchase is matched.
  {
    role: 'VAT_INPUT_PENDING',
    code: '1305',
    name: 'Input VAT — awaiting tax invoice',
    type: 'ASSET',
  },
  { role: 'ACCOUNTS_PAYABLE', code: '2000', name: 'Trade payables', type: 'LIABILITY' },
  {
    role: 'CUSTOMER_ADVANCES',
    code: '2030',
    name: 'Customer advances (unearned revenue)',
    type: 'LIABILITY',
  },
  // Card money taken on the workshop's machine for someone else, until paid
  // over to them on a payment voucher.
  {
    role: 'MONEY_HELD_FOR_OTHERS',
    code: '2040',
    name: 'Money collected for others',
    type: 'LIABILITY',
  },
  { role: 'VAT_OUTPUT', code: '2100', name: 'Output VAT payable', type: 'LIABILITY' },
  { role: 'VAT_SETTLEMENT', code: '2105', name: 'VAT due to FTA', type: 'LIABILITY' },
  { role: 'SALARIES_PAYABLE', code: '2200', name: 'Salaries & wages payable', type: 'LIABILITY' },
  {
    role: 'GRATUITY_PROVISION',
    code: '2500',
    name: 'Provision for end-of-service benefits',
    type: 'LIABILITY',
  },
  { role: 'LEAVE_PROVISION', code: '2505', name: 'Provision for annual leave', type: 'LIABILITY' },
  { role: 'STAFF_ADVANCES', code: '1110', name: 'Staff advances', type: 'ASSET' },
  { role: 'OTHER_INCOME', code: '4100', name: 'Other income', type: 'REVENUE' },
  {
    role: 'OWNER_ADVANCES',
    code: '2520',
    name: 'Due to owner (current account)',
    type: 'LIABILITY',
  },
  { role: 'OPENING_BALANCE', code: '3200', name: 'Opening balance equity', type: 'EQUITY' },
  { role: 'RETAINED_EARNINGS', code: '3900', name: 'Retained earnings', type: 'EQUITY' },
  { role: 'SALES_PARTS', code: '4000', name: 'Sales — spare parts', type: 'REVENUE' },
  { role: 'SALES_LABOUR', code: '4010', name: 'Service revenue — labour', type: 'REVENUE' },
  { role: 'SALES_OTHER', code: '4020', name: 'Sales — other', type: 'REVENUE' },
  { role: 'SALES_DISCOUNTS', code: '4090', name: 'Sales discounts', type: 'REVENUE' },
  { role: 'ROUNDING', code: '4095', name: 'Rounding adjustments', type: 'REVENUE' },
  // What an owner put in and took out (Money → Owner's money).
  { role: 'OWNER_CAPITAL', code: '3000', name: "Owner's capital", type: 'EQUITY' },
  { role: 'OWNER_DRAWINGS', code: '3100', name: "Owner's drawings", type: 'EQUITY' },
  {
    role: 'ASSET_DISPOSALS',
    code: '4110',
    name: 'Gain / (loss) on disposal of assets',
    type: 'REVENUE',
  },
  { role: 'COST_OF_PARTS', code: '5000', name: 'Cost of sales — spare parts', type: 'EXPENSE' },
  { role: 'STOCK_ADJUSTMENTS', code: '5010', name: 'Inventory adjustments', type: 'EXPENSE' },
  { role: 'SALARIES_EXPENSE', code: '5160', name: 'Salaries & wages', type: 'EXPENSE' },
  {
    role: 'GRATUITY_EXPENSE',
    code: '5165',
    name: 'End-of-service benefits expense',
    type: 'EXPENSE',
  },
  { role: 'LEAVE_EXPENSE', code: '5166', name: 'Annual leave expense', type: 'EXPENSE' },
  // What the bank keeps: the card machine's fee on a settlement.
  { role: 'BANK_CHARGES', code: '5190', name: 'Bank charges', type: 'EXPENSE' },
  { role: 'OTHER_EXPENSES', code: '5900', name: 'Miscellaneous expenses', type: 'EXPENSE' },
];

/** The rest of the standard chart, for the accountant and for filing expenses. */
export const STANDARD_ACCOUNTS: ChartAccount[] = [
  // Assets
  { code: '1005', name: 'Petty cash', type: 'ASSET', payment: true },
  { code: '1030', name: 'Post-dated cheques received (PDC)', type: 'ASSET', payment: true },
  { code: '1120', name: 'Prepaid expenses', type: 'ASSET' },
  { code: '1130', name: 'Refundable deposits', type: 'ASSET' },
  { code: '1500', name: 'Property, plant & equipment — workshop equipment', type: 'ASSET' },
  { code: '1510', name: 'Property, plant & equipment — motor vehicles', type: 'ASSET' },
  { code: '1520', name: 'Property, plant & equipment — furniture & fixtures', type: 'ASSET' },
  { code: '1530', name: 'Property, plant & equipment — computers & IT', type: 'ASSET' },
  { code: '1540', name: 'Property, plant & equipment — leasehold improvements', type: 'ASSET' },
  { code: '1590', name: 'Accumulated depreciation — property, plant & equipment', type: 'ASSET' },
  // Liabilities
  { code: '2010', name: 'Accrued expenses', type: 'LIABILITY' },
  { code: '2020', name: 'Post-dated cheques issued (PDC payable)', type: 'LIABILITY' },
  { code: '2110', name: 'Corporate tax payable', type: 'LIABILITY' },
  { code: '2510', name: 'Bank loans', type: 'LIABILITY' },
  // Equity: Owner's capital (3000) and drawings (3100) are system accounts above.
  // Income
  // Cost of sales
  { code: '5020', name: 'Cost of sales — sublet repairs', type: 'EXPENSE' },
  { code: '5030', name: 'Cost of sales — consumables & lubricants', type: 'EXPENSE' },
  // Operating expenses
  { code: '5100', name: 'Rent', type: 'EXPENSE' },
  { code: '5110', name: 'Utilities — electricity & water', type: 'EXPENSE' },
  { code: '5120', name: 'Workshop supplies', type: 'EXPENSE' },
  { code: '5130', name: 'Tools & equipment (expensed)', type: 'EXPENSE' },
  { code: '5140', name: 'Vehicle running & transport', type: 'EXPENSE' },
  { code: '5150', name: 'Repairs & maintenance', type: 'EXPENSE' },
  { code: '5170', name: 'Marketing & advertising', type: 'EXPENSE' },
  { code: '5180', name: 'Trade licence & government fees', type: 'EXPENSE' },
  { code: '5185', name: 'Visa, Emirates ID & staff medical insurance', type: 'EXPENSE' },
  // Bank charges (5190) is a system account above.
  { code: '5200', name: 'Insurance', type: 'EXPENSE' },
  { code: '5210', name: 'Telephone & internet', type: 'EXPENSE' },
  { code: '5220', name: 'Professional fees — audit & legal', type: 'EXPENSE' },
  { code: '5230', name: 'Software & subscriptions', type: 'EXPENSE' },
  { code: '5240', name: 'Printing & stationery', type: 'EXPENSE' },
  { code: '5250', name: 'Staff accommodation & transport', type: 'EXPENSE' },
  { code: '5800', name: 'Depreciation expense', type: 'EXPENSE' },
  { code: '5850', name: 'Corporate tax expense', type: 'EXPENSE' },
];

/**
 * Expense accounts coded 5000–5099 are cost of sales: they come above gross
 * profit on the profit and loss.
 */
export const isCostOfSales = (account: { type: AccountType; code: string }) =>
  account.type === 'EXPENSE' && /^50\d\d$/.test(account.code);

/** Where money taken or paid by each method goes when no account is chosen. */
export const METHOD_ACCOUNT_ROLE: Record<PaymentMethod, AccountRole> = {
  CASH: 'CASH',
  CARD: 'CARD_CLEARING',
  BANK_TRANSFER: 'BANK',
  CHEQUE: 'BANK',
  ONLINE: 'BANK',
};

/** Each system account's id, by role. */
export type RoleAccounts = Record<AccountRole, string>;

export const ROLE_LABEL: Record<AccountRole, string> = Object.fromEntries(
  SYSTEM_ACCOUNTS.map((account) => [account.role, account.name]),
) as Record<AccountRole, string>;

/** The next code after `code` not in `taken`: 1000 → 1001 → 1002 … */
function freeCode(code: string, taken: Set<string>): string {
  let candidate = Number(code);
  while (taken.has(String(candidate))) candidate += 1;
  return String(candidate);
}

type Tx = Prisma.TransactionClient;

/**
 * The money account chosen for a payment — checked to be the workshop's own,
 * in use, and one money can go in or out of. Blank means the default for the
 * payment's method; returns null then.
 */
export async function checkMoneyAccount(
  tx: Tx,
  organizationId: string,
  accountId: string | null | undefined,
): Promise<string | null> {
  if (!accountId) return null;
  const account = await tx.chartOfAccount.findFirst({
    where: { id: accountId, organizationId },
    select: { isPaymentAccount: true, isActive: true },
  });
  if (!account?.isPaymentAccount || !account.isActive) {
    throw new DomainError('Choose a cash, bank or card account that is in use.', 'accountId');
  }
  return accountId;
}

/**
 * Money the workshop pays out can't come from "Card settlements receivable":
 * that account holds what the card company owes the garage for customers who
 * paid by card. The workshop's own card is paid from the bank account it is
 * on (add a payment mode for it), or it was an owner's own card — "Paid
 * personally by…". `accountId` is the account chosen; blank means the
 * method's default, which for Card is that very account.
 */
export async function refuseCardSettlementAccount(
  tx: Tx,
  organizationId: string,
  method: PaymentMethod | null | undefined,
  accountId: string | null | undefined,
  field = 'paymentMethod',
) {
  if (!method) return;
  const account = accountId
    ? await tx.chartOfAccount.findFirst({
        where: { id: accountId, organizationId },
        select: { role: true },
      })
    : { role: METHOD_ACCOUNT_ROLE[method] };
  if (account?.role === 'CARD_CLEARING') {
    throw new DomainError(
      'Card settlements are for customers paying the garage by card. Choose the bank account the card is on, or “Paid personally by…” if it was an owner’s own card.',
      field,
    );
  }
}

const simplify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Adds the standard accounts the workshop doesn't have yet — skipping any
 * whose code is taken or whose name it already uses. Returns how many were
 * added. One insert for all of them: this can run inside the transaction of
 * the workshop's first invoice, which must stay short.
 */
export async function addStandardAccounts(tx: Tx, organizationId: string): Promise<number> {
  const existing = await tx.chartOfAccount.findMany({
    where: { organizationId },
    select: { accountCode: true, accountName: true },
  });
  const codes = new Set(existing.map((account) => account.accountCode));
  const names = new Set(existing.map((account) => simplify(account.accountName)));
  const missing = STANDARD_ACCOUNTS.filter((account) => {
    if (codes.has(account.code) || names.has(simplify(account.name))) return false;
    codes.add(account.code);
    names.add(simplify(account.name));
    return true;
  });
  if (missing.length === 0) return 0;
  const { count } = await tx.chartOfAccount.createMany({
    data: missing.map((account) => ({
      organizationId,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      isPaymentAccount: account.payment ?? false,
    })),
  });
  return count;
}

/**
 * Makes sure the workshop has every system account, and returns their ids by
 * role. Cheap once they exist (one query), so every posting calls it. The
 * first time, the rest of the standard chart is added too — in a handful of
 * queries, since it runs inside whatever is being booked.
 */
export async function ensureChart(tx: Tx, organizationId: string): Promise<RoleAccounts> {
  const read = () =>
    tx.chartOfAccount.findMany({
      where: { organizationId },
      select: { id: true, accountCode: true, accountType: true, role: true },
    });
  const byRole = (accounts: Awaited<ReturnType<typeof read>>) =>
    new Map(accounts.filter((a) => a.role).map((account) => [account.role!, account.id]));

  let accounts = await read();
  if (SYSTEM_ACCOUNTS.every((spec) => byRole(accounts).has(spec.role))) {
    return Object.fromEntries(byRole(accounts)) as RoleAccounts;
  }

  // Setting up (or completing) the chart: one transaction at a time, with
  // the workshop row as the lock.
  await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
  accounts = await read();
  const roles = byRole(accounts);
  const firstTime = roles.size === 0;
  const taken = new Set(accounts.map((account) => account.accountCode));
  const toCreate = [];
  for (const spec of SYSTEM_ACCOUNTS) {
    if (roles.has(spec.role)) continue;
    // An account of the same kind already on the code is adopted, not duplicated.
    const sameCode = accounts.find(
      (account) =>
        account.accountCode === spec.code && !account.role && account.accountType === spec.type,
    );
    if (sameCode) {
      await tx.chartOfAccount.update({
        where: { id: sameCode.id },
        data: { role: spec.role, isPaymentAccount: spec.payment ?? false },
      });
      continue;
    }
    const accountCode = freeCode(spec.code, taken);
    taken.add(accountCode);
    toCreate.push({
      organizationId,
      accountCode,
      accountName: spec.name,
      accountType: spec.type,
      role: spec.role,
      isPaymentAccount: spec.payment ?? false,
    });
  }
  if (toCreate.length) await tx.chartOfAccount.createMany({ data: toCreate });
  if (firstTime) await addStandardAccounts(tx, organizationId);
  return Object.fromEntries(byRole(await read())) as RoleAccounts;
}
