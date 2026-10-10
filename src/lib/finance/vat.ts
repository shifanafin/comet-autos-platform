import type { InvoiceStatus } from '@/generated/prisma/client';
import type { VatTreatment } from '@/generated/prisma/enums';
import { EMIRATE_BOX } from '@/lib/vat-treatment';
import { splitByTreatment, type SupplySplit } from '@/lib/finance/vat-split';

export { splitByTreatment, splitSupplies, type SupplySplit } from '@/lib/finance/vat-split';

const TREATMENT_ORDER: VatTreatment[] = ['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE'];
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { filsToString, signedToMilli, toFils } from '@/lib/money';
import { parseCalendarDate } from '@/lib/format';
import { getVatSettings } from '@/lib/tax';
import { isDiscountedLine, movementValue, receivedBefore } from '@/lib/inventory/purchase-value';
import { resolvePeriod, type ResolvedPeriod } from '@/lib/finance/dashboard';
import { VAT_DUE_DAYS } from '@/lib/compliance/rules';
import { priorPeriodsWithin } from '@/lib/accounting/prior-periods';

/*
 * The VAT return for a period — the figures a UAE VAT201 asks for, taken
 * from the records the workshop already keeps. It prepares the return; it
 * does not file it, and it is not a tax engine (see lib/tax.ts).
 *
 * OUTPUT TAX — sales
 *   Tax invoices issued in the period (ISSUED, PARTIALLY_PAID, PAID), at
 *   their own stored subtotal and VAT. Pro-forma invoices are not supplies;
 *   DRAFT, VOID and CANCELLED never count. Each line is reported by its VAT
 *   treatment — standard-rated (Box 1, against the workshop's emirate),
 *   zero-rated (Box 4), exempt (Box 5); out-of-scope lines are not supplies
 *   and are not reported. A whole-bill discount is spread over the lines in
 *   proportion, so the parts always add up to the invoice subtotal.
 *
 *   Tax credit notes issued in the period reduce the same boxes and the
 *   output VAT: a supply is adjusted in the period the credit note is
 *   issued, not the invoice's.
 *
 * INPUT TAX — what the workshop can recover
 *   Expenses dated in the period that carry VAT (voided ones never count),
 *   and parts received into stock, valued per delivery from the purchase
 *   line's cost and VAT rate, less parts returned to the supplier. Input VAT
 *   is recoverable only with the supplier's tax invoice in hand:
 *     - recorded with its tax invoice: counted by delivery date;
 *     - tax invoice matched later: the purchase's VAT is counted on the day
 *       the bill was received (lib/inventory/bills.ts);
 *     - tax invoice still to come, or none: not counted — shown apart as
 *       "awaiting tax invoice".
 *   And the bank's VAT on the card machine's fee, as each settlement says
 *   (a money transfer's charges), less the VAT on any of that fee recovered
 *   from someone the card money was really for (a payment voucher paying it
 *   over) — the books move exactly these through Input VAT recoverable.
 *
 * A workshop that is not VAT-registered charges and recovers nothing; the
 * return shows zeros and says why.
 *
 * All arithmetic is integer fils. Periods are Dubai calendar days, exactly
 * as on the finance overview.
 */

const SUPPLY_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'PAID'];

/** Days after a VAT period ends by which the return and the payment are due. */
export { VAT_DUE_DAYS };

/**
 * When a return for a period ending on `periodEnd` ("YYYY-MM-DD", the last
 * day of the quarter or month) must be filed and paid.
 */
export function vatDueDate(periodEnd: string): Date {
  return new Date(parseCalendarDate(periodEnd)!.getTime() + VAT_DUE_DAYS * 86_400_000);
}

const fils = (value: { toString(): string } | null | undefined) =>
  value ? toFils(value.toString()) : 0;

export interface VatReturnInput {
  period?: string;
  from?: string;
  to?: string;
}

export async function getVatReturn(user: AuthenticatedUser, input: VatReturnInput = {}) {
  requirePermission(user, 'vat.view');
  const period: ResolvedPeriod = resolvePeriod({ ...input, period: input.period ?? 'quarter' });
  const organizationId = user.organizationId;
  // VAT is registered and returned per TRN: the return covers every branch,
  // whoever opens it (FDL 8/2017 — one registration per legal person).
  const dates = { gte: parseCalendarDate(period.from)!, lte: parseCalendarDate(period.to)! };

  const [
    settings,
    organization,
    invoices,
    creditNotes,
    expenses,
    receipts,
    billedLater,
    awaiting,
    bankFees,
    feesRecovered,
  ] = await Promise.all([
      getVatSettings(organizationId),
      prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { emirate: true },
      }),
      prisma.invoice.findMany({
        where: {
          organizationId,
          invoiceType: 'TAX_INVOICE',
          status: { in: SUPPLY_STATUSES },
          issueDate: dates,
        },
        orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          subtotal: true,
          taxAmount: true,
          totalAmount: true,
          customerName: true,
          customerTaxNumber: true,
          jobCardId: true,
          customer: { select: { name: true, taxNumber: true } },
          items: { select: { lineTotal: true, vatTreatment: true } },
        },
      }),
      prisma.creditNote.findMany({
        where: { organizationId, status: 'ISSUED', issueDate: dates },
        orderBy: [{ issueDate: 'asc' }, { creditNoteNumber: 'asc' }],
        select: {
          id: true,
          creditNoteNumber: true,
          issueDate: true,
          subtotal: true,
          taxAmount: true,
          totalAmount: true,
          reason: true,
          invoice: {
            select: { id: true, invoiceNumber: true, customerName: true, jobCardId: true },
          },
          customer: { select: { name: true, taxNumber: true } },
          items: { select: { lineTotal: true, vatTreatment: true } },
        },
      }),
      prisma.expense.findMany({
        where: { organizationId, status: 'RECORDED', expenseDate: dates },
        orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          expenseNumber: true,
          description: true,
          vendorName: true,
          expenseDate: true,
          amount: true,
          taxAmount: true,
          chartOfAccount: { select: { accountName: true } },
        },
      }),
      // Recorded with its tax invoice: by delivery date.
      prisma.inventoryTransaction.findMany({
        where: {
          organizationId,
          transactionType: { in: ['PURCHASE_RECEIPT', 'RETURN_TO_SUPPLIER'] },
          createdAt: { gte: period.start, lt: period.end },
          purchaseItem: {
            purchase: {
              status: { notIn: ['CANCELLED', 'REVERSED'] },
              billStatus: 'RECEIVED',
              billMatchedByUserId: null,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          quantity: true,
          unitCost: true,
          createdAt: true,
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
                  id: true,
                  purchaseNumber: true,
                  supplierInvoiceNumber: true,
                  supplier: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      // Tax invoice matched later: every delivery of it, on the bill's day.
      prisma.inventoryTransaction.findMany({
        where: {
          organizationId,
          transactionType: { in: ['PURCHASE_RECEIPT', 'RETURN_TO_SUPPLIER'] },
          purchaseItem: {
            purchase: {
              status: { notIn: ['CANCELLED', 'REVERSED'] },
              billStatus: 'RECEIVED',
              billMatchedByUserId: { not: null },
              billReceivedOn: dates,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          quantity: true,
          unitCost: true,
          createdAt: true,
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
                  id: true,
                  purchaseNumber: true,
                  supplierInvoiceNumber: true,
                  billReceivedOn: true,
                  status: true,
                  billSubtotal: true,
                  billTaxAmount: true,
                  supplier: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      // Not claimable yet: received, tax invoice still to come.
      prisma.purchase.aggregate({
        where: {
          organizationId,
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] },
          billStatus: 'PENDING',
        },
        _count: { _all: true },
        _sum: { taxAmount: true },
      }),
      // The bank's fee kept from card money paid in, with its VAT.
      prisma.moneyTransfer.findMany({
        where: { organizationId, status: 'POSTED', transferredOn: dates, chargesVatAmount: { gt: 0 } },
        orderBy: [{ transferredOn: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          transferNumber: true,
          transferredOn: true,
          chargesAmount: true,
          chargesVatAmount: true,
          fromAccount: { select: { accountName: true } },
        },
      }),
      // That fee recovered from whoever the card money was for: not the workshop's to reclaim.
      prisma.paymentVoucher.findMany({
        where: {
          organizationId,
          kind: 'CARD_COLLECTION',
          status: 'PAID',
          paidOn: dates,
          feeVatAmount: { gt: 0 },
        },
        orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          voucherNumber: true,
          paidOn: true,
          payeeName: true,
          feeAmount: true,
          feeVatAmount: true,
        },
      }),
    ]);

  const registered = settings.isVatRegistered;
  const defaultRate = registered ? settings.vatRate : '0.00';

  // ── Sales, less credit notes ────────────────────────────────────────────
  const supplies: SupplySplit = { STANDARD: 0, ZERO_RATED: 0, EXEMPT: 0, OUT_OF_SCOPE: 0 };
  let outputFils = 0;
  const count = (split: SupplySplit, sign: 1 | -1) => {
    for (const treatment of TREATMENT_ORDER) supplies[treatment] += sign * split[treatment];
  };
  const sales = invoices.map((invoice) => {
    const subtotal = fils(invoice.subtotal);
    const split = splitByTreatment(subtotal, invoice.items);
    const vat = fils(invoice.taxAmount);
    count(split, 1);
    outputFils += vat;
    return {
      id: invoice.id,
      number: invoice.invoiceNumber,
      date: invoice.issueDate,
      jobCardId: invoice.jobCardId,
      party: invoice.customerName ?? invoice.customer.name,
      taxNumber: invoice.customerTaxNumber ?? invoice.customer.taxNumber,
      net: filsToString(subtotal),
      vat: filsToString(vat),
      total: invoice.totalAmount.toString(),
      /** Its share of Box 1, Box 4 and Box 5; out of scope is not reported. */
      standard: filsToString(split.STANDARD),
      zeroRated: filsToString(split.ZERO_RATED),
      exempt: filsToString(split.EXEMPT),
      outOfScope: filsToString(split.OUT_OF_SCOPE),
    };
  });
  const credits = creditNotes.map((note) => {
    const subtotal = fils(note.subtotal);
    const split = splitByTreatment(subtotal, note.items);
    const vat = fils(note.taxAmount);
    count(split, -1);
    outputFils -= vat;
    return {
      id: note.id,
      number: note.creditNoteNumber,
      date: note.issueDate,
      invoiceId: note.invoice.id,
      invoiceNumber: note.invoice.invoiceNumber,
      jobCardId: note.invoice.jobCardId,
      party: note.invoice.customerName ?? note.customer.name,
      taxNumber: note.customer.taxNumber,
      reason: note.reason,
      /** What it takes off the return, as positive figures. */
      net: filsToString(subtotal),
      vat: filsToString(vat),
      total: note.totalAmount.toString(),
      standard: filsToString(split.STANDARD),
      zeroRated: filsToString(split.ZERO_RATED),
      exempt: filsToString(split.EXEMPT),
      outOfScope: filsToString(split.OUT_OF_SCOPE),
    };
  });
  const standardFils = supplies.STANDARD;
  const zeroFils = supplies.ZERO_RATED;
  const exemptFils = supplies.EXEMPT;

  // ── Expenses with VAT ───────────────────────────────────────────────────
  let expenseNetFils = 0;
  let expenseVatFils = 0;
  const expenseRows = expenses
    .filter((expense) => fils(expense.taxAmount) > 0)
    .map((expense) => {
      const net = fils(expense.amount);
      const vat = fils(expense.taxAmount);
      expenseNetFils += net;
      expenseVatFils += vat;
      return {
        id: expense.id,
        number: expense.expenseNumber,
        date: expense.expenseDate,
        party: expense.vendorName ?? expense.chartOfAccount?.accountName ?? 'Expense',
        description: expense.description,
        net: filsToString(net),
        vat: filsToString(vat),
      };
    });

  // ── Parts received less parts returned, grouped per purchase ────────────
  const byPurchase = new Map<
    string,
    {
      id: string;
      number: string;
      reference: string | null;
      party: string;
      date: Date;
      net: number;
      vat: number;
    }
  >();
  // A discounted line values each delivery from the ones before it, even
  // those in an earlier period.
  const counted = [
    ...receipts.map((receipt) => ({ ...receipt, claimedOn: receipt.createdAt })),
    ...billedLater.map((receipt) => ({
      ...receipt,
      claimedOn: receipt.purchaseItem?.purchase.billReceivedOn ?? receipt.createdAt,
    })),
  ];
  const before = await receivedBefore(
    prisma,
    organizationId,
    counted.filter((r) => isDiscountedLine(r.purchaseItem)).map((r) => r.purchaseItem!.id),
  );
  for (const receipt of counted) {
    const item = receipt.purchaseItem;
    const qty = signedToMilli(receipt.quantity);
    if (!item || qty === 0) continue;
    // Returns carry a negative quantity; priced exactly as the books price
    // them, after any purchase discounts (lib/inventory/purchase-value.ts).
    const valued = movementValue({
      line: item,
      movementMilli: qty,
      receivedBeforeMilli: before.get(receipt.id) ?? 0,
      unitCost: (receipt.unitCost ?? item.unitCost).toString(),
      taxRate: item.taxRate?.toString() ?? defaultRate,
    });
    const purchase = item.purchase;
    const entry = byPurchase.get(purchase.id) ?? {
      id: purchase.id,
      number: purchase.purchaseNumber,
      reference: purchase.supplierInvoiceNumber,
      party: purchase.supplier.name,
      date: receipt.claimedOn,
      net: 0,
      vat: 0,
    };
    entry.net += valued.netFils;
    entry.vat += valued.taxFils;
    entry.date = receipt.claimedOn;
    byPurchase.set(purchase.id, entry);
  }
  // A bill matched later and received in full claims what the bill says —
  // the purchase may have been corrected to it (postings.ts PURCHASE_BILL).
  for (const receipt of billedLater) {
    const purchase = receipt.purchaseItem?.purchase;
    if (!purchase || purchase.status !== 'RECEIVED') continue;
    if (purchase.billSubtotal === null || purchase.billTaxAmount === null) continue;
    const entry = byPurchase.get(purchase.id);
    if (!entry) continue;
    entry.net = toFils(purchase.billSubtotal.toString());
    entry.vat = toFils(purchase.billTaxAmount.toString());
  }
  let purchaseNetFils = 0;
  let purchaseVatFils = 0;
  const purchaseRows = [...byPurchase.values()]
    .filter((row) => row.vat !== 0)
    .map((row) => {
      purchaseNetFils += row.net;
      purchaseVatFils += row.vat;
      return { ...row, net: filsToString(row.net), vat: filsToString(row.vat) };
    });

  // ── Months before these books: their totals, entered as one row a month ─
  const priorRows = await priorPeriodsWithin(organizationId, period.from, period.to);
  const prior = priorRows.reduce(
    (sum, row) => ({
      sales: sum.sales + row.salesFils,
      output: sum.output + row.salesVatFils,
      expenses: sum.expenses + row.expensesFils,
      input: sum.input + row.purchasesVatFils,
    }),
    { sales: 0, output: 0, expenses: 0, input: 0 },
  );

  const output = registered ? outputFils + prior.output : 0;
  // ── Bank charges: the card machine's fee, less what was recovered ───────
  let bankNetFils = 0;
  let bankVatFils = 0;
  const bankChargeRows = [
    ...bankFees.map((transfer) => ({
      id: transfer.id,
      number: transfer.transferNumber,
      date: transfer.transferredOn,
      party: 'Bank',
      description: `Fee kept from ${transfer.fromAccount.accountName}`,
      net: fils(transfer.chargesAmount),
      vat: fils(transfer.chargesVatAmount),
      href: '/finance/money/transfers',
    })),
    ...feesRecovered.map((voucher) => ({
      id: voucher.id,
      number: voucher.voucherNumber,
      date: voucher.paidOn!,
      party: voucher.payeeName,
      description: 'Bank fee recovered on card money paid over',
      net: -fils(voucher.feeAmount),
      vat: -fils(voucher.feeVatAmount),
      href: `/finance/payment-vouchers/${voucher.id}`,
    })),
  ]
    .sort((x, y) => x.date.getTime() - y.date.getTime())
    .map((row) => {
      bankNetFils += row.net;
      bankVatFils += row.vat;
      const signed = (value: number) =>
        value < 0 ? `-${filsToString(-value)}` : filsToString(value);
      return { ...row, net: signed(row.net), vat: signed(row.vat) };
    });

  const inputFils = registered ? expenseVatFils + purchaseVatFils + bankVatFils + prior.input : 0;

  return {
    period,
    /**
     * When the return and any payment are due: 28 days after the last day of
     * the period itself — the quarter's end for "This quarter", not today.
     */
    dueDate: vatDueDate(period.periodEnd),
    registered,
    rate: settings.vatRate,
    taxNumber: settings.taxNumber,
    /** The emirate the standard-rated supplies are reported against. */
    emirate: { value: organization.emirate, ...EMIRATE_BOX[organization.emirate] },
    boxes: {
      /** Box 1 — standard-rated supplies, less credit notes. */
      standardSupplies: filsToString(registered ? standardFils + prior.sales : 0),
      outputVat: filsToString(output),
      /** Box 4 — zero-rated supplies. */
      zeroRatedSupplies: filsToString(registered ? zeroFils : 0),
      /** Box 5 — exempt supplies. */
      exemptSupplies: filsToString(registered ? exemptFils : 0),
      /** Not reported: out of scope of VAT. */
      outOfScopeSupplies: filsToString(registered ? supplies.OUT_OF_SCOPE : 0),
      /** Box 8 — total supplies. */
      totalSupplies: filsToString(registered ? standardFils + prior.sales + zeroFils + exemptFils : 0),
      /** Box 9 — standard-rated expenses (expenses + parts received). */
      standardExpenses: filsToString(
        registered ? expenseNetFils + purchaseNetFils + bankNetFils + prior.expenses : 0,
      ),
      inputVat: filsToString(inputFils),
      expenseVat: filsToString(registered ? expenseVatFils : 0),
      purchaseVat: filsToString(registered ? purchaseVatFils : 0),
      /** The bank's VAT on card fees, less what was recovered from others. Can be below zero. */
      bankChargesVat:
        registered && bankVatFils < 0
          ? `-${filsToString(-bankVatFils)}`
          : filsToString(registered ? bankVatFils : 0),
      /** Box 14 — positive is payable, negative is refundable. */
      net: filsToString(output - inputFils),
      netFils: output - inputFils,
    },
    sales,
    credits,
    expenses: expenseRows,
    purchases: purchaseRows,
    bankCharges: bankChargeRows,
    /** Months before these books, entered as totals: in Box 1 and Box 9. */
    priorPeriods: priorRows.map((row) => ({
      id: row.id,
      from: row.from,
      to: row.to,
      sales: filsToString(row.salesFils),
      salesVat: filsToString(row.salesVatFils),
      expenses: filsToString(row.expensesFils),
      purchasesVat: filsToString(row.purchasesVatFils),
    })),
    /** Prior-month input VAT, part of inputVat. */
    priorVat: filsToString(registered ? prior.input : 0),
    /** Parts received whose tax invoice hasn't come yet: their VAT isn't claimable until it does. */
    awaitingTaxInvoice: {
      purchases: awaiting._count._all,
      vat: (awaiting._sum.taxAmount ?? 0).toString(),
    },
  };
}

export type VatReturn = Awaited<ReturnType<typeof getVatReturn>>;
