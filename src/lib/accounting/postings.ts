import type { Prisma } from '@/generated/prisma/client';
import type { AccountRole, JournalSource } from '@/generated/prisma/enums';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { milliToString, multiplyQuantity, signedToMilli, toFils } from '@/lib/money';
import { withNetQuantities } from '@/lib/inventory/stock';
import { movementValue, receivedBefore } from '@/lib/inventory/purchase-value';
import { purchaseBillDifferenceFils } from '@/lib/finance/supplier-balance';
import { getVatSettings, resolveDefaultVatRate } from '@/lib/tax';
import { OWNER_MONEY_LABEL } from '@/lib/finance/owner-money-labels';
import { METHOD_ACCOUNT_ROLE, type RoleAccounts } from '@/lib/accounting/chart';
import { priorPostingAmounts, stockCarried } from '@/lib/accounting/prior-period-rules';

/*
 * What each record should have in the books — the posting rules, in one
 * place. Each function reads one record as it stands now and returns the
 * journal entry it calls for, or null when it calls for none (a void
 * invoice, a voided expense). lib/accounting/journal.ts compares that with
 * what is already booked and books the difference.
 *
 * The rules (all amounts exact, in fils):
 *
 * OPENING BALANCE INVOICE (what a customer owed when the books began)
 *   Dr Trade receivables              the balance
 *   Cr Opening balance equity         — no sale, no VAT
 *
 * INVOICE (a tax invoice, once issued; nothing while draft or void)
 *   Dr Accounts receivable            total
 *   Cr each line's income account     its amount after its own discount
 *                                     (the account chosen on the line, else
 *                                     parts / labour / other sales)
 *   Dr Discounts given                the bill discount
 *   Cr VAT payable                    the VAT
 *   Cr / Dr Rounding adjustments      the round-off, outside VAT
 *   Dr Cost of parts sold             parts fitted on its job, at cost,
 *   Cr Parts inventory                after any taken back — and each PART
 *                                     line sold from stock (part_id), at the
 *                                     cost decided on the line
 *
 * PAYMENT from a customer             Dr the cash, bank or card account
 *                                     Cr Accounts receivable
 *   its reversal                      the same, the other way round
 *
 * EXPENSE (recorded; nothing once void)
 *   Dr its category                   the amount excluding VAT
 *   Dr VAT recoverable                the VAT (a business not registered
 *                                     for VAT can't recover it: it stays in
 *                                     the category)
 *   Cr the account it was paid from, Accounts payable while unpaid, or
 *      Due to owner when an owner paid it with their own money (the line
 *      names them)
 *
 * OWNER REIMBURSEMENT                 Dr Due to owner
 *                                     Cr the cash or bank account
 *   its reversal                      the same, the other way round
 *
 * STOCK MOVEMENT
 *   delivery from a supplier          Dr Parts inventory, Dr VAT recoverable
 *   (and returns to one, negative)    Cr Accounts payable
 *     — tax invoice still to come      the VAT to Input VAT awaiting tax
 *                                     invoice instead (claimable only once
 *                                     the bill is in hand)
 *     — supplier gives no tax invoice  the VAT stays in the parts' cost
 *   a part sold on an invoice line    nothing here — costed on that invoice
 *   opening stock                     Dr Parts inventory
 *                                     Cr Opening balance equity
 *   adjustment (count, damage…)       Dr/Cr Parts inventory
 *                                     Cr/Dr Stock adjustments
 *   parts fitted to or taken back from a job: nothing here — they are costed
 *   on the job's invoice (above), matched to the sale.
 *
 * PURCHASE ROUND-OFF (the supplier's "adjusted amount", outside VAT; once
 * the whole purchase is received, on the day it was)
 *   round-off down (−)                Dr Accounts payable / Cr Rounding adjustments
 *   round-off up (+)                  Dr Rounding adjustments / Cr Accounts payable
 *
 * PURCHASE BILL (the supplier's tax invoice, matched after the parts; on
 * the day it was received)
 *   bill received                     Dr Input VAT recoverable
 *                                     Cr Input VAT awaiting tax invoice
 *   no tax invoice after all          Dr Cost of parts sold
 *                                     Cr Input VAT awaiting tax invoice
 *
 * SUPPLIER PAYMENT                    Dr Accounts payable
 *                                     Cr the cash or bank account
 *   its reversal                      the same, the other way round
 *
 * PAYROLL (approved or paid; nothing if cancelled before payment)
 *   when approved, at the period end  Dr Salaries & wages     the wage cost: pay
 *                                                             and overtime, less
 *                                                             unpaid days
 *                                     Cr Salaries payable     net pay
 *                                     Cr Staff advances       advances recovered
 *                                     Cr Other income         penalties and other
 *                                                             hand deductions
 *   and, in the same entry,           Dr End-of-service benefits expense
 *                                     Cr Provision for end-of-service benefits
 *                                     Dr Annual leave expense
 *                                     Cr Provision for annual leave
 *                                     what was set aside for the month (the other
 *                                     way round when it fell — leave taken)
 *   when paid, on the day paid        Dr Salaries payable
 *                                     Cr Bank
 *
 * FINAL SETTLEMENT (approved; reversed if cancelled), at the leaving date
 *                                     Dr Provision for end-of-service benefits
 *                                        and Dr/Cr the expense for the difference
 *                                     Dr Provision for annual leave
 *                                        and Dr/Cr the expense for the difference
 *                                     Dr Salaries & wages     notice pay, additions
 *                                     Cr Staff advances       recoveries
 *                                     Cr Salaries payable     net payable
 *   when paid                         Dr Salaries payable / Cr the money account
 *
 * VAT RETURN (filed with the FTA)
 *   when filed, at the period end     Dr Output VAT payable   the output VAT
 *                                     Cr Input VAT recoverable the input VAT
 *                                     Cr VAT due to FTA        the difference
 *                                     (Dr, when the FTA owes a refund)
 *   when paid or refunded             Dr VAT due to FTA / Cr Bank, or the
 *                                     other way round for a refund
 *
 * CREDIT NOTE (issued; nothing once void) — the invoice's entry, undone in part
 *   Dr each line's income account     its amount
 *   Cr Sales discounts                any bill discount taken back with it
 *   Dr Output VAT payable             the VAT
 *   Dr / Cr Rounding adjustments      the invoice's round-off, taken back by
 *                                     the note that credits its last lines
 *   Cr Trade receivables              the total
 *   its refund, on the day paid       Dr Trade receivables / Cr the account paid from
 *
 * INVOICE DISCOUNT (given after the invoice, off its total; its own entry,
 * on the day given — the invoice's entry and VAT untouched)
 *   Dr Sales discounts                the discount
 *   Cr Trade receivables              the discount
 *
 * MONEY TRANSFER (nothing once void)
 *   Dr the account it went to         what arrived
 *   Dr Bank charges                   what the bank kept (card machine fee)
 *   Dr Input VAT recoverable          the bank's VAT on it (registered only;
 *                                     otherwise part of the bank charges)
 *   Cr the account it came from       all of it
 *
 * PAYMENT VOUCHER — card money collected for someone else (nothing once void)
 *   collected, on its day             Dr the card account
 *                                     Cr Money collected for others
 *   paid over, on its day             Dr Money collected for others  collected
 *                                     Cr the account paid from       handed over
 *                                     Cr Bank charges                the bank's fee
 *                                     Cr Input VAT recoverable       its VAT
 *   (outside work on a voucher is an expense, booked as one)
 *
 * OWNER'S MONEY (Money → Owner's money; nothing once void)
 *   capital in                        Dr the money account / Cr Owner's capital
 *   loan in                           Dr the money account / Cr Due to owner
 *   drawings                          Dr Owner's drawings / Cr the money account
 *
 * CUSTOMER ADVANCE (money paid before any invoice; nothing once cancelled)
 *   received                          Dr the cash, bank or card account
 *                                     Cr Customer advances
 *   applied to an invoice             Dr Customer advances
 *                                     Cr Trade receivables — the invoice's
 *                                     revenue and VAT are untouched
 *   returned to it by a credit note   Dr Trade receivables
 *                                     Cr Customer advances
 *   refunded                          Dr Customer advances
 *                                     Cr the account paid from
 *   VAT: none on the advance while its treatment awaits the accountant's
 *   confirmation; VAT is on the invoice, as for any sale.
 *
 * FIXED ASSET
 *   bought                            Dr the asset account    its cost
 *                                     Cr the account paid from, Trade payables
 *                                     (bought on credit) or Opening balance
 *                                     equity (owned before the books began,
 *                                     with any depreciation charged before then)
 *   each month's depreciation         Dr Depreciation expense
 *                                     Cr Accumulated depreciation
 *   sold or scrapped                  Dr Accumulated depreciation, Dr the
 *                                     proceeds, Cr the asset's cost; the
 *                                     difference to Gain / (loss) on disposal
 */

export interface PostingLine {
  accountId: string;
  /** Fils. One of debit and credit is zero. */
  debit: number;
  credit: number;
  /** A note on the line: a manual entry's own, or who paid an expense personally. */
  memo?: string | null;
  /** On an account kept per party: the customer or supplier the line is for. */
  customerId?: string | null;
  supplierId?: string | null;
}

export interface Posting {
  /** The accounting date: the record's own date. */
  date: Date;
  branchId: string | null;
  description: string;
  lines: PostingLine[];
}

/** The workshop's calendar day a moment falls on. */
export function accountingDay(moment: Date): Date {
  return parseCalendarDate(localDateString(moment))!;
}

/**
 * Builds balanced lines from signed amounts (positive = debit, negative =
 * credit), netted per account, zero amounts left out.
 */
class Lines {
  private readonly net = new Map<string, number>();
  private readonly memos = new Map<string, string>();

  /** A note on the account's line in the journal (who paid, for instance). */
  memo(accountId: string, text: string) {
    this.memos.set(accountId, text);
    return this;
  }

  add(accountId: string, fils: number) {
    if (fils !== 0) this.net.set(accountId, (this.net.get(accountId) ?? 0) + fils);
    return this;
  }

  debit(accountId: string, fils: number) {
    return this.add(accountId, fils);
  }

  credit(accountId: string, fils: number) {
    return this.add(accountId, -fils);
  }

  build(): PostingLine[] {
    const lines = [...this.net.entries()]
      .filter(([, fils]) => fils !== 0)
      .map(([accountId, fils]) => ({
        accountId,
        debit: Math.max(fils, 0),
        credit: Math.max(-fils, 0),
        ...(this.memos.has(accountId) ? { memo: this.memos.get(accountId) } : {}),
      }));
    const debits = lines.reduce((sum, line) => sum + line.debit, 0);
    const credits = lines.reduce((sum, line) => sum + line.credit, 0);
    if (debits !== credits) {
      // A rule above is wrong; never book it.
      throw new Error(`Posting does not balance: debits ${debits}, credits ${credits}.`);
    }
    return lines;
  }
}

const fils = (value: { toString(): string } | null | undefined) =>
  value
    ? toFils(value.toString().replace(/^-/, '')) * (value.toString().startsWith('-') ? -1 : 1)
    : 0;

const SALES_ROLE: Record<string, AccountRole> = {
  PART: 'SALES_PARTS',
  LABOUR: 'SALES_LABOUR',
  OTHER: 'SALES_OTHER',
};

type Tx = Prisma.TransactionClient;
type Poster = (
  tx: Tx,
  organizationId: string,
  sourceId: string,
  accounts: RoleAccounts,
) => Promise<Posting | null>;

async function isVatRegistered(tx: Tx, organizationId: string) {
  return (await getVatSettings(organizationId, tx)).isVatRegistered;
}

// ─── Invoices ───────────────────────────────────────────────────────────────

const postInvoice: Poster = async (tx, organizationId, invoiceId, accounts) => {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: {
      invoiceType: true,
      status: true,
      invoiceNumber: true,
      customerName: true,
      issueDate: true,
      branchId: true,
      jobCardId: true,
      discountAmount: true,
      taxAmount: true,
      totalAmount: true,
      roundingAdjustment: true,
      items: {
        select: {
          itemType: true,
          accountId: true,
          lineTotal: true,
          quantity: true,
          partId: true,
          unitCost: true,
          partUsageId: true,
        },
      },
      customer: { select: { name: true } },
    },
  });
  if (!invoice || invoice.invoiceType === 'PROFORMA') return null;
  if (invoice.status === 'DRAFT' || invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
    return null;
  }

  // A customer's balance from before the books began: owed, but neither a
  // sale nor VAT — its other side is opening balance equity.
  if (invoice.invoiceType === 'OPENING_BALANCE') {
    const total = fils(invoice.totalAmount);
    return {
      date: invoice.issueDate,
      branchId: invoice.branchId,
      description: `Opening balance ${invoice.invoiceNumber} — ${invoice.customerName ?? invoice.customer.name}`,
      lines: new Lines()
        .debit(accounts.ACCOUNTS_RECEIVABLE, total)
        .credit(accounts.OPENING_BALANCE, total)
        .build(),
    };
  }

  const lines = new Lines()
    .debit(accounts.ACCOUNTS_RECEIVABLE, fils(invoice.totalAmount))
    .debit(accounts.SALES_DISCOUNTS, fils(invoice.discountAmount))
    .credit(accounts.VAT_OUTPUT, fils(invoice.taxAmount))
    // Signed: a round-off up is income, a round-off down a cost.
    .credit(accounts.ROUNDING, fils(invoice.roundingAdjustment));
  for (const item of invoice.items) {
    const account =
      item.accountId ?? accounts[SALES_ROLE[item.itemType ?? 'OTHER'] ?? 'SALES_OTHER'];
    lines.credit(account, fils(item.lineTotal));
  }

  // The parts fitted on its job, at what they cost, after any taken back.
  if (invoice.jobCardId) {
    const usages = await tx.partUsage.findMany({
      where: { organizationId, jobCardId: invoice.jobCardId },
      select: { id: true, quantity: true, unitCost: true },
    });
    const net = await withNetQuantities(tx, organizationId, usages);
    const cost = net.reduce(
      (sum, usage) =>
        sum +
        (usage.netMilli > 0
          ? multiplyQuantity(milliToString(usage.netMilli), usage.unitCost.toString())
          : 0),
      0,
    );
    lines.debit(accounts.COST_OF_PARTS, cost).credit(accounts.INVENTORY, cost);
  }

  // Parts sold from stock on its own lines (not through a job's repair
  // records), at the cost decided on each line — the same quantity the
  // line's SALE movement took out of stock.
  const sold = invoice.items
    .filter((item) => item.partId && !item.partUsageId && item.unitCost)
    .reduce(
      (sum, item) => sum + multiplyQuantity(item.quantity.toString(), item.unitCost!.toString()),
      0,
    );
  lines.debit(accounts.COST_OF_PARTS, sold).credit(accounts.INVENTORY, sold);

  return {
    date: invoice.issueDate,
    branchId: invoice.branchId,
    description: `Invoice ${invoice.invoiceNumber} — ${invoice.customerName ?? invoice.customer.name}`,
    lines: lines.build(),
  };
};

/**
 * A discount given after the invoice, off its total — its own entry, on the
 * day it was given; the invoice's entry stays as issued. VAT is untouched
 * (only a tax credit note reduces it). Nothing once the invoice is void.
 */
const postInvoiceDiscount: Poster = async (tx, organizationId, invoiceId, accounts) => {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: {
      status: true,
      invoiceNumber: true,
      customerName: true,
      branchId: true,
      settlementDiscount: true,
      settlementDiscountOn: true,
    },
  });
  if (!invoice || !invoice.settlementDiscountOn) return null;
  if (invoice.status === 'DRAFT' || invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
    return null;
  }
  const amount = fils(invoice.settlementDiscount);
  return {
    date: invoice.settlementDiscountOn,
    branchId: invoice.branchId,
    description: `Discount on invoice ${invoice.invoiceNumber}${invoice.customerName ? ` — ${invoice.customerName}` : ''}`,
    lines: new Lines()
      .debit(accounts.SALES_DISCOUNTS, amount)
      .credit(accounts.ACCOUNTS_RECEIVABLE, amount)
      .build(),
  };
};

/**
 * A purchase's round-off — the supplier's small adjustment after VAT — once
 * the whole purchase is received, on the day it was. Signed: a round-off
 * down lowers what is owed and is a gain; up raises it and is a cost.
 */
const postPurchaseRounding: Poster = async (tx, organizationId, purchaseId, accounts) => {
  const purchase = await tx.purchase.findFirst({
    where: { id: purchaseId, organizationId },
    select: {
      status: true,
      purchaseNumber: true,
      supplierInvoiceNumber: true,
      branchId: true,
      receivedAt: true,
      roundingAdjustment: true,
      supplier: { select: { name: true } },
    },
  });
  if (!purchase || purchase.status !== 'RECEIVED' || !purchase.receivedAt) return null;
  const rounding = fils(purchase.roundingAdjustment);
  return {
    date: accountingDay(purchase.receivedAt),
    branchId: purchase.branchId,
    description: `Round-off on ${purchase.purchaseNumber}${purchase.supplierInvoiceNumber ? ` (supplier invoice ${purchase.supplierInvoiceNumber})` : ''} — ${purchase.supplier.name}`,
    lines: new Lines()
      .credit(accounts.ACCOUNTS_PAYABLE, rounding)
      .debit(accounts.ROUNDING, rounding)
      .build(),
  };
};

// ─── Customer payments ──────────────────────────────────────────────────────

const postPayment: Poster = async (tx, organizationId, paymentId, accounts) => {
  const payment = await tx.payment.findFirst({
    where: { id: paymentId, organizationId },
    select: {
      amount: true,
      method: true,
      accountId: true,
      paymentNumber: true,
      receivedAt: true,
      reversalOf: { select: { paymentNumber: true, method: true, accountId: true } },
      invoice: { select: { invoiceNumber: true, branchId: true, customerName: true } },
    },
  });
  if (!payment) return null;

  // A reversal takes the money back out of the account the original went into.
  const original = payment.reversalOf ?? payment;
  const moneyAccount = original.accountId ?? accounts[METHOD_ACCOUNT_ROLE[original.method]];
  const amount = fils(payment.amount);
  const lines = payment.reversalOf
    ? new Lines().debit(accounts.ACCOUNTS_RECEIVABLE, amount).credit(moneyAccount, amount)
    : new Lines().debit(moneyAccount, amount).credit(accounts.ACCOUNTS_RECEIVABLE, amount);

  const on = `${payment.invoice.invoiceNumber}${payment.invoice.customerName ? ` — ${payment.invoice.customerName}` : ''}`;
  return {
    date: accountingDay(payment.receivedAt),
    branchId: payment.invoice.branchId,
    description: payment.reversalOf
      ? `Payment ${payment.reversalOf.paymentNumber ?? ''} reversed, on ${on}`
      : `Payment ${payment.paymentNumber ?? ''} received on ${on}`,
    lines: lines.build(),
  };
};

// ─── Expenses ───────────────────────────────────────────────────────────────

const postExpense: Poster = async (tx, organizationId, expenseId, accounts) => {
  const expense = await tx.expense.findFirst({
    where: { id: expenseId, organizationId },
    select: {
      status: true,
      expenseNumber: true,
      description: true,
      vendorName: true,
      amount: true,
      taxAmount: true,
      expenseDate: true,
      branchId: true,
      chartOfAccountId: true,
      paymentMethod: true,
      paidFromAccountId: true,
      paidByUser: { select: { fullName: true } },
    },
  });
  if (!expense || expense.status !== 'RECORDED') return null;

  const net = fils(expense.amount);
  const vat = fils(expense.taxAmount);
  const recoverable = await isVatRegistered(tx, organizationId);
  const category = expense.chartOfAccountId ?? accounts.OTHER_EXPENSES;
  const paidFrom = expense.paidByUser
    ? accounts.OWNER_ADVANCES
    : expense.paymentMethod
      ? (expense.paidFromAccountId ?? accounts[METHOD_ACCOUNT_ROLE[expense.paymentMethod]])
      : accounts.ACCOUNTS_PAYABLE;
  const lines = new Lines()
    .debit(category, recoverable ? net : net + vat)
    .debit(accounts.VAT_INPUT, recoverable ? vat : 0)
    .credit(paidFrom, net + vat);
  if (expense.paidByUser) {
    lines.memo(paidFrom, `Paid personally by ${expense.paidByUser.fullName}`);
  }

  return {
    date: expense.expenseDate,
    branchId: expense.branchId,
    description: `Expense ${expense.expenseNumber ?? ''} — ${expense.description}${expense.vendorName ? ` (${expense.vendorName})` : ''}`,
    lines: lines.build(),
  };
};

// ─── Stock movements ────────────────────────────────────────────────────────

const postStockMovement: Poster = async (tx, organizationId, movementId, accounts) => {
  const movement = await tx.inventoryTransaction.findFirst({
    where: { id: movementId, organizationId },
    select: {
      transactionType: true,
      quantity: true,
      unitCost: true,
      note: true,
      createdAt: true,
      branchId: true,
      part: { select: { sku: true, name: true } },
      reversalOf: { select: { transactionType: true, note: true } },
      purchaseItem: {
        select: {
          id: true,
          quantityOrdered: true,
          unitCost: true,
          taxRate: true,
          taxAmount: true,
          netAmount: true,
          purchase: {
            select: {
              purchaseNumber: true,
              billStatus: true,
              billMatchedByUserId: true,
              supplier: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!movement || !movement.unitCost) return null;

  const milli = signedToMilli(movement.quantity);
  const sign = milli < 0 ? -1 : 1;
  const quantity = milliToString(Math.abs(milli));
  const value = sign * multiplyQuantity(quantity, movement.unitCost.toString());
  const what = `${movement.part.name} (${movement.part.sku})`;
  const base = { date: accountingDay(movement.createdAt), branchId: movement.branchId };
  // A reversal (of an adjustment or opening stock) is booked like the movement
  // it cancels: its quantity has the opposite sign, so the entry runs the other
  // way and the two net to nothing.
  const reversed = movement.transactionType === 'REVERSAL' ? movement.reversalOf : null;
  const type = reversed?.transactionType ?? movement.transactionType;
  const note = reversed?.note ?? movement.note;
  const prefix = reversed ? 'Reversed — ' : '';
  const openingStock =
    type === 'OPENING_STOCK' || (type === 'ADJUSTMENT' && /^opening stock/i.test(note ?? ''));

  if (
    movement.transactionType === 'PURCHASE_RECEIPT' ||
    movement.transactionType === 'RETURN_TO_SUPPLIER'
  ) {
    // Priced exactly as the supplier balance prices it, so what is owed in
    // the books is what the payables screen shows — after any purchase
    // discounts (lib/inventory/purchase-value.ts).
    const line = movement.purchaseItem;
    const rate = line?.taxRate?.toString() ?? (await resolveDefaultVatRate(organizationId, tx));
    const before =
      line?.netAmount !== null && line?.netAmount !== undefined
        ? ((await receivedBefore(tx, organizationId, [line.id])).get(movementId) ?? 0)
        : 0;
    const { netFils: net, taxFils: vat } = movementValue({
      line,
      movementMilli: milli,
      receivedBeforeMilli: before,
      unitCost: movement.unitCost.toString(),
      taxRate: rate,
    });
    const purchase = movement.purchaseItem?.purchase;
    const vatTo = receiptVatAccount(purchase, await isVatRegistered(tx, organizationId));
    return {
      ...base,
      description: `${sign > 0 ? 'Stock received' : 'Stock returned'}: ${what}${purchase ? ` — ${purchase.purchaseNumber}, ${purchase.supplier.name}` : ''}${vatTo === 'PENDING' && vat !== 0 ? ' (tax invoice awaited)' : ''}`,
      lines: new Lines()
        .debit(accounts.INVENTORY, vatTo === 'COST' ? net + vat : net)
        .debit(accounts.VAT_INPUT, vatTo === 'RECOVERABLE' ? vat : 0)
        .debit(accounts.VAT_INPUT_PENDING, vatTo === 'PENDING' ? vat : 0)
        .credit(accounts.ACCOUNTS_PAYABLE, net + vat)
        .build(),
    };
  }
  if (openingStock) {
    return {
      ...base,
      description: `${prefix}Opening stock: ${what}`,
      lines: new Lines()
        .debit(accounts.INVENTORY, value)
        .credit(accounts.OPENING_BALANCE, value)
        .build(),
    };
  }
  if (type === 'ADJUSTMENT') {
    return {
      ...base,
      description: `${prefix}Stock adjustment: ${what}${note ? ` — ${note}` : ''}`,
      lines: new Lines()
        .debit(accounts.INVENTORY, value)
        .credit(accounts.STOCK_ADJUSTMENTS, value)
        .build(),
    };
  }
  // Fitted to or taken back from a job, moved between branches: costed on
  // the job's invoice, or no change in value at all.
  return null;
};

/**
 * Where a delivery's input VAT is booked:
 *
 *   RECOVERABLE  the tax invoice was in hand when the purchase was recorded;
 *   PENDING      the tax invoice is still to come, or came later and is moved
 *                on its own entry (PURCHASE BILL) — so this entry never has to
 *                change when the bill arrives;
 *   COST         not VAT-registered, or the supplier gave no tax invoice from
 *                the start: the VAT is part of what the parts cost.
 *
 * "Came later" is told by billMatchedByUserId: set when someone matches the
 * bill after the parts were received (lib/inventory/bills.ts).
 */
export function receiptVatAccount(
  purchase: { billStatus: string; billMatchedByUserId: string | null } | null | undefined,
  vatRegistered: boolean,
): 'RECOVERABLE' | 'PENDING' | 'COST' {
  if (!vatRegistered) return 'COST';
  if (!purchase) return 'RECOVERABLE';
  if (purchase.billStatus === 'PENDING' || purchase.billMatchedByUserId) return 'PENDING';
  if (purchase.billStatus === 'NO_TAX_INVOICE') return 'COST';
  return 'RECOVERABLE';
}

/** The input VAT of a purchase's deliveries (less returns), in fils, priced as each was booked. */
async function purchaseDeliveredVat(tx: Tx, organizationId: string, purchaseId: string) {
  const movements = await tx.inventoryTransaction.findMany({
    where: {
      organizationId,
      transactionType: { in: ['PURCHASE_RECEIPT', 'RETURN_TO_SUPPLIER'] },
      purchaseItem: { purchaseId },
    },
    select: {
      id: true,
      quantity: true,
      unitCost: true,
      purchaseItem: {
        select: {
          id: true,
          quantityOrdered: true,
          unitCost: true,
          taxRate: true,
          taxAmount: true,
          netAmount: true,
        },
      },
    },
  });
  const defaultRate = await resolveDefaultVatRate(organizationId, tx);
  let vat = 0;
  for (const movement of movements) {
    if (!movement.unitCost) continue;
    const line = movement.purchaseItem;
    const before =
      line?.netAmount !== null && line?.netAmount !== undefined
        ? ((await receivedBefore(tx, organizationId, [line.id])).get(movement.id) ?? 0)
        : 0;
    vat += movementValue({
      line,
      movementMilli: signedToMilli(movement.quantity),
      receivedBeforeMilli: before,
      unitCost: movement.unitCost.toString(),
      taxRate: line?.taxRate?.toString() ?? defaultRate,
    }).taxFils;
  }
  return vat;
}

/**
 * The supplier's tax invoice, matched after the parts arrived: the VAT held
 * as "awaiting tax invoice" is claimed (or, with no tax invoice after all,
 * becomes part of the cost of sales), on the day the bill was received.
 */
const postPurchaseBill: Poster = async (tx, organizationId, purchaseId, accounts) => {
  const purchase = await tx.purchase.findFirst({
    where: { id: purchaseId, organizationId },
    select: {
      purchaseNumber: true,
      supplierInvoiceNumber: true,
      branchId: true,
      billStatus: true,
      billReceivedOn: true,
      billMatchedByUserId: true,
      status: true,
      subtotal: true,
      taxAmount: true,
      totalAmount: true,
      billSubtotal: true,
      billTaxAmount: true,
      billTotalAmount: true,
      supplier: { select: { name: true } },
    },
  });
  if (!purchase || !purchase.billMatchedByUserId || purchase.billStatus === 'PENDING') return null;
  if (!purchase.billReceivedOn) return null;
  const registered = await isVatRegistered(tx, organizationId);
  // What waits in "awaiting tax invoice" for it.
  const held = registered ? await purchaseDeliveredVat(tx, organizationId, purchaseId) : 0;
  const received = purchase.billStatus === 'RECEIVED';
  const lines = new Lines().credit(accounts.VAT_INPUT_PENDING, held);

  // Received in full and the bill's figures recorded: the bill decides — its
  // VAT is claimed, and what it says beyond what was recorded is owed (or
  // not) to the supplier, the price difference on cost of sales and any
  // rounding to round-off (lib/finance/supplier-balance.ts counts the same).
  const settled =
    received &&
    purchase.status === 'RECEIVED' &&
    purchase.billSubtotal !== null &&
    purchase.billTaxAmount !== null &&
    purchase.billTotalAmount !== null;
  let differs = false;
  if (settled) {
    const claimed = registered ? fils(purchase.billTaxAmount) : 0;
    const owedMore = purchaseBillDifferenceFils(purchase);
    const costMore = registered
      ? fils(purchase.billSubtotal) - fils(purchase.subtotal)
      : fils(purchase.billSubtotal) +
        fils(purchase.billTaxAmount) -
        fils(purchase.subtotal) -
        fils(purchase.taxAmount);
    differs = owedMore !== 0;
    lines
      .debit(accounts.VAT_INPUT, claimed)
      .credit(accounts.ACCOUNTS_PAYABLE, owedMore)
      .debit(accounts.COST_OF_PARTS, costMore)
      // What is left is the shop's rounding.
      .debit(accounts.ROUNDING, owedMore + held - claimed - costMore);
  } else {
    lines.debit(received ? accounts.VAT_INPUT : accounts.COST_OF_PARTS, held);
  }
  const built = lines.build();
  if (built.length === 0) return null;
  return {
    date: purchase.billReceivedOn,
    branchId: purchase.branchId,
    description: received
      ? `Tax invoice ${purchase.supplierInvoiceNumber ?? ''} received for ${purchase.purchaseNumber} — ${purchase.supplier.name}: ${differs ? 'corrected to the bill, ' : ''}VAT now claimable`.replace(
          '  ',
          ' ',
        )
      : `No tax invoice for ${purchase.purchaseNumber} — ${purchase.supplier.name}: VAT becomes cost`,
    lines: built,
  };
};

// ─── Supplier payments ──────────────────────────────────────────────────────

const postSupplierPayment: Poster = async (tx, organizationId, paymentId, accounts) => {
  const payment = await tx.supplierPayment.findFirst({
    where: { id: paymentId, organizationId },
    select: {
      amount: true,
      method: true,
      accountId: true,
      supplierPaymentNumber: true,
      paidAt: true,
      reversalOf: { select: { supplierPaymentNumber: true, method: true, accountId: true } },
      purchase: {
        select: { purchaseNumber: true, branchId: true, supplier: { select: { name: true } } },
      },
    },
  });
  if (!payment) return null;

  const original = payment.reversalOf ?? payment;
  const moneyAccount = original.accountId ?? accounts[METHOD_ACCOUNT_ROLE[original.method]];
  const amount = fils(payment.amount);
  const lines = payment.reversalOf
    ? new Lines().debit(moneyAccount, amount).credit(accounts.ACCOUNTS_PAYABLE, amount)
    : new Lines().debit(accounts.ACCOUNTS_PAYABLE, amount).credit(moneyAccount, amount);
  const to = `${payment.purchase.supplier.name}, ${payment.purchase.purchaseNumber}`;
  return {
    date: accountingDay(payment.paidAt),
    branchId: payment.purchase.branchId,
    description: payment.reversalOf
      ? `Supplier payment ${payment.reversalOf.supplierPaymentNumber ?? ''} reversed — ${to}`
      : `Supplier payment ${payment.supplierPaymentNumber ?? ''} — ${to}`,
    lines: lines.build(),
  };
};

// ─── Money moved between the workshop's own accounts ───────────────────────

/**
 * Cash on hand into the petty-cash box, takings into the bank: the money is
 * the workshop's either side, so nothing is earned or spent.
 *   Dr the account it went to      Cr the account it came from
 * A void transfer books nothing (its entry is reversed).
 */
const postMoneyTransfer: Poster = async (tx, organizationId, transferId, accounts) => {
  const transfer = await tx.moneyTransfer.findFirst({
    where: { id: transferId, organizationId },
    select: {
      status: true,
      transferNumber: true,
      amount: true,
      chargesAmount: true,
      chargesVatAmount: true,
      transferredOn: true,
      fromAccountId: true,
      toAccountId: true,
      fromAccount: { select: { accountName: true } },
      toAccount: { select: { accountName: true } },
    },
  });
  if (!transfer || transfer.status !== 'POSTED') return null;
  const amount = fils(transfer.amount);
  // What the bank kept on the way: its fee, and the VAT on it — reclaimed
  // when the workshop is VAT-registered, otherwise part of the charge.
  const charges = fils(transfer.chargesAmount);
  const chargesVat = fils(transfer.chargesVatAmount);
  const recoverable = chargesVat > 0 && (await isVatRegistered(tx, organizationId));
  return {
    date: transfer.transferredOn,
    branchId: null,
    description: `Money moved ${transfer.transferNumber}: ${transfer.fromAccount.accountName} to ${transfer.toAccount.accountName}${charges + chargesVat > 0 ? ', less bank charges' : ''}`,
    lines: new Lines()
      .debit(transfer.toAccountId, amount)
      .debit(accounts.BANK_CHARGES, recoverable ? charges : charges + chargesVat)
      .debit(accounts.VAT_INPUT, recoverable ? chargesVat : 0)
      .credit(transfer.fromAccountId, amount + charges + chargesVat)
      .build(),
  };
};

// ─── Payment vouchers ───────────────────────────────────────────────────────

async function paymentVoucher(tx: Tx, organizationId: string, voucherId: string) {
  return tx.paymentVoucher.findFirst({
    where: { id: voucherId, organizationId },
    select: {
      kind: true,
      status: true,
      voucherNumber: true,
      branchId: true,
      payeeName: true,
      collectedOn: true,
      collectedAmount: true,
      cardAccountId: true,
      feeAmount: true,
      feeVatAmount: true,
      amount: true,
      paidOn: true,
      paymentMethod: true,
      paidFromAccountId: true,
    },
  });
}

/**
 * Card money taken on the workshop's machine for someone else: it is in the
 * card account like any card payment, but it is theirs — owed to them.
 */
const postCardCollection: Poster = async (tx, organizationId, voucherId, accounts) => {
  const voucher = await paymentVoucher(tx, organizationId, voucherId);
  if (
    !voucher ||
    voucher.kind !== 'CARD_COLLECTION' ||
    voucher.status === 'VOID' ||
    !voucher.collectedOn
  ) {
    return null;
  }
  const collected = fils(voucher.collectedAmount);
  return {
    date: voucher.collectedOn,
    branchId: voucher.branchId,
    description: `Card payment collected for ${voucher.payeeName} (${voucher.voucherNumber})`,
    lines: new Lines()
      .debit(voucher.cardAccountId ?? accounts.CARD_CLEARING, collected)
      .credit(accounts.MONEY_HELD_FOR_OTHERS, collected)
      .build(),
  };
};

/**
 * That money paid over, less what the bank kept for it. The fee was theirs:
 * recovered from them, it comes off Bank charges — and its VAT off what the
 * workshop reclaims, since the workshop no longer bears that fee.
 */
const postPaymentVoucher: Poster = async (tx, organizationId, voucherId, accounts) => {
  const voucher = await paymentVoucher(tx, organizationId, voucherId);
  if (
    !voucher ||
    voucher.kind !== 'CARD_COLLECTION' ||
    voucher.status !== 'PAID' ||
    !voucher.paidOn ||
    !voucher.paymentMethod
  ) {
    return null;
  }
  const collected = fils(voucher.collectedAmount);
  const paid = fils(voucher.amount);
  const fee = fils(voucher.feeAmount);
  const feeVat = fils(voucher.feeVatAmount);
  const recoverable = feeVat > 0 && (await isVatRegistered(tx, organizationId));
  const paidFrom =
    voucher.paidFromAccountId ?? accounts[METHOD_ACCOUNT_ROLE[voucher.paymentMethod]];
  return {
    date: voucher.paidOn,
    branchId: voucher.branchId,
    description: `Payment voucher ${voucher.voucherNumber} — card money paid over to ${voucher.payeeName}`,
    lines: new Lines()
      .debit(accounts.MONEY_HELD_FOR_OTHERS, collected)
      .credit(paidFrom, paid)
      .credit(accounts.BANK_CHARGES, recoverable ? fee : fee + feeVat)
      .credit(accounts.VAT_INPUT, recoverable ? feeVat : 0)
      .build(),
  };
};

// ─── Owner's money ──────────────────────────────────────────────────────────

/**
 * An owner putting money in (to stay: capital; to be taken back: a loan, owed
 * to them as Due to owner) or taking it out for themselves (drawings).
 */
const postOwnerMoney: Poster = async (tx, organizationId, id, accounts) => {
  const row = await tx.ownerMoney.findFirst({
    where: { id, organizationId },
    select: {
      status: true,
      entryNumber: true,
      kind: true,
      amount: true,
      movedOn: true,
      accountId: true,
      owner: { select: { fullName: true } },
      partner: { select: { name: true } },
    },
  });
  if (!row || row.status !== 'POSTED') return null;
  const amount = fils(row.amount);
  const who = row.partner?.name ?? row.owner?.fullName;
  const lines =
    row.kind === 'DRAWINGS'
      ? new Lines().debit(accounts.OWNER_DRAWINGS, amount).credit(row.accountId, amount)
      : new Lines()
          .debit(row.accountId, amount)
          .credit(
            row.kind === 'LOAN_IN' ? accounts.OWNER_ADVANCES : accounts.OWNER_CAPITAL,
            amount,
          );
  return {
    date: row.movedOn,
    branchId: null,
    description: `${OWNER_MONEY_LABEL[row.kind]} ${row.entryNumber}${who ? ` — ${who}` : ''}`,
    lines: lines.build(),
  };
};

// ─── Owners repaid ──────────────────────────────────────────────────────────

const postOwnerReimbursement: Poster = async (tx, organizationId, id, accounts) => {
  const row = await tx.ownerReimbursement.findFirst({
    where: { id, organizationId },
    select: {
      amount: true,
      method: true,
      paidFromAccountId: true,
      paidOn: true,
      person: { select: { fullName: true } },
      reversalOf: { select: { method: true, paidFromAccountId: true } },
    },
  });
  if (!row) return null;
  const original = row.reversalOf ?? row;
  const moneyAccount = original.paidFromAccountId ?? accounts[METHOD_ACCOUNT_ROLE[original.method]];
  const amount = fils(row.amount);
  const lines = row.reversalOf
    ? new Lines().debit(moneyAccount, amount).credit(accounts.OWNER_ADVANCES, amount)
    : new Lines().debit(accounts.OWNER_ADVANCES, amount).credit(moneyAccount, amount);
  lines.memo(accounts.OWNER_ADVANCES, row.person.fullName);
  return {
    date: row.paidOn,
    branchId: null,
    description: row.reversalOf
      ? `Repayment to ${row.person.fullName} reversed`
      : `Repaid ${row.person.fullName} for business costs paid personally`,
    lines: lines.build(),
  };
};

// ─── Payroll ────────────────────────────────────────────────────────────────

async function payrollRun(tx: Tx, organizationId: string, payrollId: string) {
  return tx.payroll.findFirst({
    where: { id: payrollId, organizationId },
    select: {
      status: true,
      periodStart: true,
      periodEnd: true,
      approvedAt: true,
      paidAt: true,
      items: {
        select: {
          netPay: true,
          gratuityAccrual: true,
          leaveAccrual: true,
          otherDeduction: true,
          otherDeductionKind: true,
        },
      },
    },
  });
}

const payrollMonth = (run: { periodStart: Date }) => run.periodStart.toISOString().slice(0, 7);

const postPayroll: Poster = async (tx, organizationId, payrollId, accounts) => {
  const run = await payrollRun(tx, organizationId, payrollId);
  if (!run || (run.status !== 'APPROVED' && run.status !== 'PAID')) return null;
  const signedFils = (value: { toString(): string }) => {
    const text = value.toString();
    return text.startsWith('-') ? -fils(text.slice(1)) : fils(text);
  };
  const net = run.items.reduce((sum, item) => sum + fils(item.netPay), 0);
  // Hand deductions: an advance recovered clears Staff advances; the rest is income.
  let advances = 0;
  let otherIncome = 0;
  for (const item of run.items) {
    const amount = fils(item.otherDeduction);
    if (item.otherDeductionKind === 'ADVANCE') advances += amount;
    else otherIncome += amount;
  }
  // Below zero when less is owed than was set aside (a lower salary, leave taken).
  const gratuity = run.items.reduce((sum, item) => sum + signedFils(item.gratuityAccrual), 0);
  const leave = run.items.reduce((sum, item) => sum + signedFils(item.leaveAccrual), 0);
  return {
    date: run.periodEnd,
    branchId: null,
    description: `Payroll ${payrollMonth(run)} — salaries owed`,
    lines: new Lines()
      .debit(accounts.SALARIES_EXPENSE, net + advances + otherIncome)
      .credit(accounts.SALARIES_PAYABLE, net)
      .credit(accounts.STAFF_ADVANCES, advances)
      .credit(accounts.OTHER_INCOME, otherIncome)
      .debit(accounts.GRATUITY_EXPENSE, gratuity)
      .credit(accounts.GRATUITY_PROVISION, gratuity)
      .debit(accounts.LEAVE_EXPENSE, leave)
      .credit(accounts.LEAVE_PROVISION, leave)
      .build(),
  };
};

const postPayrollPayment: Poster = async (tx, organizationId, payrollId, accounts) => {
  const run = await payrollRun(tx, organizationId, payrollId);
  if (!run || run.status !== 'PAID' || !run.paidAt) return null;
  const net = run.items.reduce((sum, item) => sum + fils(item.netPay), 0);
  return {
    date: accountingDay(run.paidAt),
    branchId: null,
    description: `Payroll ${payrollMonth(run)} — salaries paid`,
    lines: new Lines().debit(accounts.SALARIES_PAYABLE, net).credit(accounts.BANK, net).build(),
  };
};

// ─── Final settlements ──────────────────────────────────────────────────────

async function finalSettlement(tx: Tx, organizationId: string, settlementId: string) {
  return tx.finalSettlement.findFirst({
    where: { id: settlementId, organizationId },
    select: {
      status: true,
      terminationDate: true,
      gratuity: true,
      gratuityProvision: true,
      leaveEncashment: true,
      leaveProvision: true,
      noticePay: true,
      otherAdditions: true,
      recoveries: true,
      netPayable: true,
      paidOn: true,
      paidFromAccountId: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });
}

const postFinalSettlement: Poster = async (tx, organizationId, settlementId, accounts) => {
  const row = await finalSettlement(tx, organizationId, settlementId);
  if (!row || (row.status !== 'APPROVED' && row.status !== 'PAID')) return null;
  const signedFils = (value: { toString(): string }) => {
    const text = value.toString();
    return text.startsWith('-') ? -fils(text.slice(1)) : fils(text);
  };
  const gratuity = fils(row.gratuity);
  const gratuityHeld = fils(row.gratuityProvision);
  const leave = fils(row.leaveEncashment);
  const leaveHeld = fils(row.leaveProvision);
  const who = `${row.employee.firstName} ${row.employee.lastName}`.trim();
  return {
    date: row.terminationDate,
    branchId: null,
    description: `Final settlement — ${who}`,
    lines: new Lines()
      // What was set aside is used; the difference is this period's cost (or a release).
      .debit(accounts.GRATUITY_PROVISION, gratuityHeld)
      .debit(accounts.GRATUITY_EXPENSE, gratuity - gratuityHeld)
      .debit(accounts.LEAVE_PROVISION, leaveHeld)
      .debit(accounts.LEAVE_EXPENSE, leave - leaveHeld)
      .debit(accounts.SALARIES_EXPENSE, signedFils(row.noticePay) + fils(row.otherAdditions))
      .credit(accounts.STAFF_ADVANCES, fils(row.recoveries))
      .credit(accounts.SALARIES_PAYABLE, fils(row.netPayable))
      .build(),
  };
};

const postFinalSettlementPayment: Poster = async (tx, organizationId, settlementId, accounts) => {
  const row = await finalSettlement(tx, organizationId, settlementId);
  if (!row || row.status !== 'PAID' || !row.paidOn) return null;
  const net = fils(row.netPayable);
  const who = `${row.employee.firstName} ${row.employee.lastName}`.trim();
  return {
    date: row.paidOn,
    branchId: null,
    description: `Final settlement paid — ${who}`,
    lines: new Lines()
      .debit(accounts.SALARIES_PAYABLE, net)
      .credit(row.paidFromAccountId ?? accounts.BANK, net)
      .build(),
  };
};

// ─── VAT returns ────────────────────────────────────────────────────────────

async function vatFiling(tx: Tx, organizationId: string, filingId: string) {
  return tx.vatFiling.findFirst({
    where: { id: filingId, organizationId },
    select: {
      periodFrom: true,
      periodTo: true,
      outputVat: true,
      inputVat: true,
      netVat: true,
      ftaReference: true,
      settledOn: true,
      settledAccountId: true,
      outsideBooks: true,
    },
  });
}

const vatPeriod = (filing: { periodFrom: Date; periodTo: Date }) =>
  `${filing.periodFrom.toISOString().slice(0, 10)} to ${filing.periodTo.toISOString().slice(0, 10)}`;

const postVatFiling: Poster = async (tx, organizationId, filingId, accounts) => {
  const filing = await vatFiling(tx, organizationId, filingId);
  // Filed before these books began: its VAT is in the opening balances.
  if (!filing || filing.outsideBooks) return null;
  return {
    date: filing.periodTo,
    branchId: null,
    description: `VAT return ${vatPeriod(filing)} filed${filing.ftaReference ? ` (FTA ref. ${filing.ftaReference})` : ''}`,
    lines: new Lines()
      .debit(accounts.VAT_OUTPUT, fils(filing.outputVat))
      .credit(accounts.VAT_INPUT, fils(filing.inputVat))
      .credit(accounts.VAT_SETTLEMENT, fils(filing.netVat))
      .build(),
  };
};

const postVatPayment: Poster = async (tx, organizationId, filingId, accounts) => {
  const filing = await vatFiling(tx, organizationId, filingId);
  if (!filing?.settledOn) return null;
  if (filing.outsideBooks) {
    // A return from before the books: paid before they began, it is in the
    // opening balances; paid since, the money left the bank in these books.
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { openingBalanceDate: true },
    });
    const booksStart = organization?.openingBalanceDate;
    if (!booksStart || filing.settledOn < booksStart) return null;
  }
  const net = fils(filing.netVat);
  const account = filing.settledAccountId ?? accounts.BANK;
  // VAT owed from before the books began: not in "VAT due to FTA" (only
  // returns filed here go there), so the payment settles it against the
  // opening balance equity that held it.
  const owedFrom = filing.outsideBooks ? accounts.OPENING_BALANCE : accounts.VAT_SETTLEMENT;
  return {
    date: filing.settledOn,
    branchId: null,
    description:
      net >= 0
        ? `VAT paid to the FTA for ${vatPeriod(filing)}`
        : `VAT refund received from the FTA for ${vatPeriod(filing)}`,
    // A positive net is paid out of the account; a negative one comes in.
    lines: new Lines().debit(owedFrom, net).credit(account, net).build(),
  };
};

// ─── Months before the books ────────────────────────────────────────────────

/**
 * One month's totals from before the books (lib/accounting/prior-period-rules.ts
 * has the entry). The latest month also carries the parts still in stock
 * when the books began off the cost of parts.
 */
const postPriorPeriod: Poster = async (tx, organizationId, summaryId, accounts) => {
  const row = await tx.priorPeriodSummary.findFirst({
    where: { id: summaryId, organizationId },
  });
  if (!row) return null;
  const latest = await tx.priorPeriodSummary.findFirst({
    where: { organizationId },
    orderBy: { periodTo: 'desc' },
    select: { id: true },
  });
  let stock = 0;
  if (latest?.id === row.id) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { openingBalanceDate: true },
    });
    if (organization?.openingBalanceDate) {
      const [onHand, bought] = await Promise.all([
        tx.journalEntryLine.aggregate({
          where: {
            organizationId,
            chartOfAccountId: accounts.INVENTORY,
            journalEntry: {
              entryDate: { lte: organization.openingBalanceDate },
              sourceType: { not: 'PRIOR_PERIOD' },
            },
          },
          _sum: { debitAmount: true, creditAmount: true },
        }),
        tx.priorPeriodSummary.aggregate({
          where: { organizationId },
          _sum: { partsBought: true },
        }),
      ]);
      stock = stockCarried(
        fils(onHand._sum.debitAmount) - fils(onHand._sum.creditAmount),
        fils(bought._sum.partsBought),
      );
    }
  }
  const amounts = priorPostingAmounts(
    {
      salesFils: fils(row.sales),
      partsFils: fils(row.partsBought),
      costsWithVatFils: fils(row.costsWithVat),
      costsWithoutVatFils: fils(row.costsWithoutVat),
      salariesFils: fils(row.salaries),
    },
    stock,
  );
  const lines = new Lines()
    .credit(accounts.SALES_OTHER, amounts.sales)
    .debit(accounts.COST_OF_PARTS, amounts.costOfParts)
    .debit(accounts.OTHER_EXPENSES, amounts.otherExpenses)
    .debit(accounts.SALARIES_EXPENSE, amounts.salaries)
    .debit(accounts.OPENING_BALANCE, amounts.openingEquity);
  if (stock) lines.memo(accounts.COST_OF_PARTS, 'Less parts still in stock when the books began');
  const from = row.periodFrom.toISOString().slice(0, 10);
  const to = row.periodTo.toISOString().slice(0, 10);
  return {
    date: row.periodTo,
    branchId: null,
    description: `Totals before these books: ${from} to ${to}`,
    lines: lines.build(),
  };
};

// ─── Credit notes ───────────────────────────────────────────────────────────

const postCreditNote: Poster = async (tx, organizationId, creditNoteId, accounts) => {
  const note = await tx.creditNote.findFirst({
    where: { id: creditNoteId, organizationId },
    select: {
      status: true,
      creditNoteNumber: true,
      issueDate: true,
      branchId: true,
      discountAmount: true,
      taxAmount: true,
      totalAmount: true,
      roundingAmount: true,
      items: {
        select: {
          itemType: true,
          accountId: true,
          lineTotal: true,
          returnedQuantity: true,
          unitCost: true,
        },
      },
      invoice: { select: { invoiceNumber: true, customerName: true } },
    },
  });
  if (!note || note.status !== 'ISSUED') return null;
  const lines = new Lines()
    .credit(accounts.ACCOUNTS_RECEIVABLE, fils(note.totalAmount))
    .credit(accounts.SALES_DISCOUNTS, fils(note.discountAmount))
    .debit(accounts.VAT_OUTPUT, fils(note.taxAmount))
    .debit(accounts.ROUNDING, fils(note.roundingAmount));
  for (const item of note.items) {
    const account =
      item.accountId ?? accounts[SALES_ROLE[item.itemType ?? 'OTHER'] ?? 'SALES_OTHER'];
    lines.debit(account, fils(item.lineTotal));
  }
  // Parts the customer brought back: in stock again, off cost of sales, at
  // the cost they were sold at (lib/inventory/credit-note-stock.ts).
  const back = note.items
    .filter((item) => item.returnedQuantity && item.unitCost)
    .reduce(
      (sum, item) =>
        sum + multiplyQuantity(item.returnedQuantity!.toString(), item.unitCost!.toString()),
      0,
    );
  lines.debit(accounts.INVENTORY, back).credit(accounts.COST_OF_PARTS, back);
  return {
    date: note.issueDate,
    branchId: note.branchId,
    description: `Credit note ${note.creditNoteNumber} against ${note.invoice.invoiceNumber}${note.invoice.customerName ? ` — ${note.invoice.customerName}` : ''}`,
    lines: lines.build(),
  };
};

const postCreditNoteRefund: Poster = async (tx, organizationId, creditNoteId, accounts) => {
  const note = await tx.creditNote.findFirst({
    where: { id: creditNoteId, organizationId },
    select: {
      status: true,
      creditNoteNumber: true,
      branchId: true,
      refundAmount: true,
      refundedOn: true,
      refundMethod: true,
      refundAccountId: true,
    },
  });
  if (!note || note.status !== 'ISSUED' || !note.refundedOn) return null;
  const amount = fils(note.refundAmount);
  const account =
    note.refundAccountId ?? accounts[METHOD_ACCOUNT_ROLE[note.refundMethod ?? 'CASH']];
  return {
    date: note.refundedOn,
    branchId: note.branchId,
    description: `Refund to the customer under credit note ${note.creditNoteNumber}`,
    lines: new Lines().debit(accounts.ACCOUNTS_RECEIVABLE, amount).credit(account, amount).build(),
  };
};

// ─── Customer advances ──────────────────────────────────────────────────────

const postCustomerAdvance: Poster = async (tx, organizationId, advanceId, accounts) => {
  const advance = await tx.customerAdvance.findFirst({
    where: { id: advanceId, organizationId },
    select: {
      status: true,
      advanceNumber: true,
      branchId: true,
      amount: true,
      receivedOn: true,
      method: true,
      accountId: true,
      vatTreatment: true,
      customer: { select: { name: true } },
    },
  });
  if (!advance || advance.status === 'CANCELLED') return null;
  if (advance.vatTreatment === 'VAT_ON_RECEIPT') {
    // Not switched on until the accountant confirms it: never book a guess.
    throw new Error('VAT on receipt of customer advances is not enabled.');
  }
  const amount = fils(advance.amount);
  const moneyAccount = advance.accountId ?? accounts[METHOD_ACCOUNT_ROLE[advance.method]];
  return {
    date: advance.receivedOn,
    branchId: advance.branchId,
    description: `Customer advance ${advance.advanceNumber} received — ${advance.customer.name}`,
    lines: new Lines()
      .debit(moneyAccount, amount)
      .credit(accounts.CUSTOMER_ADVANCES, amount)
      .build(),
  };
};

const postAdvanceAllocation: Poster = async (tx, organizationId, allocationId, accounts) => {
  const allocation = await tx.customerAdvanceAllocation.findFirst({
    where: { id: allocationId, organizationId },
    select: {
      amount: true,
      allocatedOn: true,
      reversedAt: true,
      advance: { select: { advanceNumber: true, branchId: true } },
      invoice: { select: { invoiceNumber: true, customerName: true } },
      creditNote: { select: { creditNoteNumber: true } },
    },
  });
  if (!allocation || allocation.reversedAt) return null;
  // Signed: above zero applies the advance, below zero returns money to it.
  const amount = fils(allocation.amount);
  const who = allocation.invoice.customerName ? ` — ${allocation.invoice.customerName}` : '';
  return {
    date: allocation.allocatedOn,
    branchId: allocation.advance.branchId,
    description: allocation.creditNote
      ? `Returned to customer advance ${allocation.advance.advanceNumber} from ${allocation.invoice.invoiceNumber} by credit note ${allocation.creditNote.creditNoteNumber}${who}`
      : `Customer advance ${allocation.advance.advanceNumber} applied to ${allocation.invoice.invoiceNumber}${who}`,
    lines: new Lines()
      .debit(accounts.CUSTOMER_ADVANCES, amount)
      .credit(accounts.ACCOUNTS_RECEIVABLE, amount)
      .build(),
  };
};

const postAdvanceRefund: Poster = async (tx, organizationId, refundId, accounts) => {
  const refund = await tx.customerAdvanceRefund.findFirst({
    where: { id: refundId, organizationId },
    select: {
      amount: true,
      refundedOn: true,
      method: true,
      accountId: true,
      reversedAt: true,
      advance: {
        select: { advanceNumber: true, branchId: true, customer: { select: { name: true } } },
      },
    },
  });
  if (!refund || refund.reversedAt) return null;
  const amount = fils(refund.amount);
  const moneyAccount = refund.accountId ?? accounts[METHOD_ACCOUNT_ROLE[refund.method]];
  return {
    date: refund.refundedOn,
    branchId: refund.advance.branchId,
    description: `Customer advance ${refund.advance.advanceNumber} refunded — ${refund.advance.customer.name}`,
    lines: new Lines()
      .debit(accounts.CUSTOMER_ADVANCES, amount)
      .credit(moneyAccount, amount)
      .build(),
  };
};

// ─── Fixed assets ───────────────────────────────────────────────────────────

const postFixedAsset: Poster = async (tx, organizationId, assetId, accounts) => {
  const asset = await tx.fixedAsset.findFirst({
    where: { id: assetId, organizationId },
    select: {
      assetNumber: true,
      name: true,
      acquiredOn: true,
      cost: true,
      funding: true,
      paidFromAccountId: true,
      openingDepreciation: true,
      openingThrough: true,
      assetAccountId: true,
      accumulatedAccountId: true,
    },
  });
  if (!asset) return null;
  const cost = fils(asset.cost);
  const against =
    asset.funding === 'PAID'
      ? (asset.paidFromAccountId ?? accounts.BANK)
      : asset.funding === 'ON_CREDIT'
        ? accounts.ACCOUNTS_PAYABLE
        : accounts.OPENING_BALANCE;
  const lines = new Lines().debit(asset.assetAccountId, cost).credit(against, cost);
  if (asset.funding === 'OPENING') {
    // Depreciation already charged before the books began.
    const opening = fils(asset.openingDepreciation);
    lines.debit(accounts.OPENING_BALANCE, opening).credit(asset.accumulatedAccountId, opening);
  }
  return {
    // Owned before the books began: it comes in on the day its depreciation was charged to.
    date:
      asset.funding === 'OPENING' && asset.openingThrough ? asset.openingThrough : asset.acquiredOn,
    branchId: null,
    description: `Fixed asset ${asset.assetNumber} — ${asset.name}${asset.funding === 'OPENING' ? ' (opening balance)' : ''}`,
    lines: lines.build(),
  };
};

const postDepreciation: Poster = async (tx, organizationId, depreciationId) => {
  const row = await tx.assetDepreciation.findFirst({
    where: { id: depreciationId, organizationId },
    select: {
      periodEnd: true,
      amount: true,
      fixedAsset: {
        select: {
          assetNumber: true,
          name: true,
          expenseAccountId: true,
          accumulatedAccountId: true,
        },
      },
    },
  });
  if (!row) return null;
  const amount = fils(row.amount);
  return {
    date: row.periodEnd,
    branchId: null,
    description: `Depreciation ${row.periodEnd.toISOString().slice(0, 7)} — ${row.fixedAsset.assetNumber} ${row.fixedAsset.name}`,
    lines: new Lines()
      .debit(row.fixedAsset.expenseAccountId, amount)
      .credit(row.fixedAsset.accumulatedAccountId, amount)
      .build(),
  };
};

const postAssetDisposal: Poster = async (tx, organizationId, assetId, accounts) => {
  const asset = await tx.fixedAsset.findFirst({
    where: { id: assetId, organizationId },
    select: {
      status: true,
      assetNumber: true,
      name: true,
      cost: true,
      openingDepreciation: true,
      disposedOn: true,
      disposalProceeds: true,
      proceedsAccountId: true,
      assetAccountId: true,
      accumulatedAccountId: true,
      depreciations: { select: { amount: true } },
    },
  });
  if (!asset || asset.status !== 'DISPOSED' || !asset.disposedOn) return null;
  const accumulated =
    fils(asset.openingDepreciation) +
    asset.depreciations.reduce((sum, row) => sum + fils(row.amount), 0);
  const proceeds = fils(asset.disposalProceeds);
  const cost = fils(asset.cost);
  // Book value is cost less depreciation; proceeds above it are a gain.
  const gain = proceeds - (cost - accumulated);
  return {
    date: asset.disposedOn,
    branchId: null,
    description: `Disposal of ${asset.assetNumber} — ${asset.name}`,
    lines: new Lines()
      .debit(asset.accumulatedAccountId, accumulated)
      .debit(asset.proceedsAccountId ?? accounts.BANK, proceeds)
      .credit(asset.assetAccountId, cost)
      .credit(accounts.ASSET_DISPOSALS, gain)
      .build(),
  };
};

/** The posting rule for each kind of record. MANUAL entries are made by hand. */
export const POSTING_RULES: Record<
  Exclude<JournalSource, 'MANUAL' | 'OPENING_BALANCE' | 'YEAR_END_CLOSE'>,
  Poster
> = {
  INVOICE: postInvoice,
  PAYMENT: postPayment,
  EXPENSE: postExpense,
  STOCK_MOVEMENT: postStockMovement,
  SUPPLIER_PAYMENT: postSupplierPayment,
  PAYROLL: postPayroll,
  PAYROLL_PAYMENT: postPayrollPayment,
  VAT_FILING: postVatFiling,
  VAT_PAYMENT: postVatPayment,
  CREDIT_NOTE: postCreditNote,
  CREDIT_NOTE_REFUND: postCreditNoteRefund,
  FIXED_ASSET: postFixedAsset,
  DEPRECIATION: postDepreciation,
  ASSET_DISPOSAL: postAssetDisposal,
  OWNER_REIMBURSEMENT: postOwnerReimbursement,
  MONEY_TRANSFER: postMoneyTransfer,
  CUSTOMER_ADVANCE: postCustomerAdvance,
  CUSTOMER_ADVANCE_ALLOCATION: postAdvanceAllocation,
  CUSTOMER_ADVANCE_REFUND: postAdvanceRefund,
  INVOICE_DISCOUNT: postInvoiceDiscount,
  PURCHASE_ROUNDING: postPurchaseRounding,
  OWNER_MONEY: postOwnerMoney,
  PURCHASE_BILL: postPurchaseBill,
  CARD_COLLECTION: postCardCollection,
  PAYMENT_VOUCHER: postPaymentVoucher,
  PRIOR_PERIOD: postPriorPeriod,
  FINAL_SETTLEMENT: postFinalSettlement,
  FINAL_SETTLEMENT_PAYMENT: postFinalSettlementPayment,
};
