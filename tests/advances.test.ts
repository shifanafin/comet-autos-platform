/**
 * Integration tests for customer advances (lib/billing/advances.ts):
 *
 *  - received: Dr cash / Cr Customer advances (2030), numbered ADV-, linked
 *    to the customer, vehicle and job card; no VAT while the treatment is
 *    pending the accountant;
 *  - applied: Dr Customer advances / Cr Trade receivables — the invoice's
 *    revenue, taxable amount and VAT untouched; partial, several advances on
 *    one invoice, one advance on several invoices; never more than is left
 *    or due; a job card it settles moves to Paid;
 *  - invoice balance = total − credit notes − payments − advance applied;
 *  - undo, refund, refund reversal and cancel each reverse their own entry
 *    and keep the record;
 *  - a credit note that over-settles an invoice gives the money back to the
 *    advance first; voiding it reapplies the money, unless it was used since;
 *  - an invoice with an advance applied can't be voided until it is undone;
 *  - the new invoice form: the customer's advance applied as the invoice is
 *    issued, a sale paid on the spot taking only what is left; a quotation
 *    changed on the form billed as changed, still linked to the quotation;
 *  - the statement, the balance sheet and the unbooked count agree.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { ensureChart } from '@/lib/accounting/chart';
import { countUnbooked } from '@/lib/accounting/entries';
import { getBalanceSheet } from '@/lib/accounting/reports';
import {
  applyCustomerAdvance,
  cancelCustomerAdvance,
  customerAdvanceHeld,
  getCustomerAdvance,
  receiveCustomerAdvance,
  refundCustomerAdvance,
  reverseAdvanceRefund,
  undoAdvanceApplication,
} from '@/lib/billing/advances';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { getInvoiceDetail, recordInvoicePayment } from '@/lib/billing/invoice';
import { voidInvoice } from '@/lib/billing/invoice-changes';
import { createCreditNote, getCreditableInvoice, voidCreditNote } from '@/lib/billing/credit-notes';
import { getCustomerStatement } from '@/lib/finance/statements';
import { checkInVehicle } from '@/lib/workshop/check-in';
import {
  createQuotation,
  recordCustomerDecision,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { filsToString, toFils } from '@/lib/money';
import { advanceVatReleases } from '@/lib/billing/advance-vat';
import { getVatReturn } from '@/lib/finance/vat';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let customerId: string;
let vehicleId: string;
let jobCardId: string;
let strangerId: string;
let strangerVehicleId: string;

before(async () => {
  a = await createTestOrg('Advances');
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  const customer = await prisma.customer.create({
    data: { organizationId: a.organizationId, name: `Mohammed ${RUN}`, phone: '050 222 3344' },
  });
  customerId = customer.id;
  vehicleId = (
    await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId,
        plateNumber: `P ${RUN.slice(-5)}`,
        make: 'Nissan',
        model: 'Patrol',
      },
    })
  ).id;
  ({ jobCardId } = await checkInVehicle(a.owner, {
    mode: 'existing',
    vehicleId,
    visit: { complaint: 'Gearbox repair' },
  }));
  const stranger = await prisma.customer.create({
    data: { organizationId: a.organizationId, name: `Someone ${RUN}`, phone: '050 999 1122' },
  });
  strangerId = stranger.id;
  strangerVehicleId = (
    await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId: stranger.id,
        plateNumber: `S ${RUN.slice(-5)}`,
        make: 'Toyota',
        model: 'Hilux',
      },
    })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

const today = () => localDateString();

/** Net debit per account, in fils, over the entries booking these records. */
async function bookedFor(...sourceIds: string[]) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: a.organizationId, journalEntry: { sourceId: { in: sourceIds } } },
    select: { chartOfAccountId: true, debitAmount: true, creditAmount: true },
  });
  const net = new Map<string, number>();
  for (const line of lines) {
    const value = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    net.set(line.chartOfAccountId, (net.get(line.chartOfAccountId) ?? 0) + value);
  }
  for (const [key, value] of net) if (value === 0) net.delete(key);
  return net;
}

const invoiceOf = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });
const advanceOf = (id: string) => getCustomerAdvance(a.owner, id);

async function labourInvoice(amount: string, extra: Record<string, unknown> = {}) {
  const { invoiceId } = await createDirectInvoice(a.owner, {
    customerId,
    items: [{ itemType: 'LABOUR', description: 'Repair work', quantity: '1', unitPrice: amount }],
    ...extra,
  });
  return invoiceId;
}

describe('receiving an advance', () => {
  let advanceId: string;

  test('AED 2,000 towards the Patrol on its job card: Dr cash, Cr Customer advances (2030) and output VAT', async () => {
    const advance = await receiveCustomerAdvance(a.owner, {
      customerId,
      jobCardId,
      amount: '2000',
      receivedOn: today(),
      method: 'CASH',
      notes: 'Advance for repair',
    });
    advanceId = advance.id;
    assert.match(advance.advanceNumber, /^ADV-/);
    const row = await prisma.customerAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    assert.equal(row.vehicleId, vehicleId, 'the job card’s vehicle is filled in');
    assert.equal(row.status, 'OPEN');
    // VAT is due the day an advance is received: 2,000 = 1,904.76 + 95.24 VAT.
    assert.equal(row.vatTreatment, 'VAT_ON_RECEIPT');
    assert.equal(row.vatAmount.toString(), '95.24');

    const account = await prisma.chartOfAccount.findUniqueOrThrow({
      where: { id: roles.CUSTOMER_ADVANCES },
    });
    assert.equal(account.accountCode, '2030');
    assert.equal(account.accountType, 'LIABILITY');

    const booked = await bookedFor(advance.id);
    assert.equal(booked.get(roles.CASH), toFils('2000.00'));
    assert.equal(booked.get(roles.CUSTOMER_ADVANCES), -toFils('1904.76'));
    assert.equal(booked.get(roles.VAT_OUTPUT), -toFils('95.24'));
    assert.equal(booked.size, 3, 'VAT, but no income');
    assert.equal(await customerAdvanceHeld(prisma, a.organizationId, customerId), toFils('2000'));
  });

  test('always for one of the customer’s own job cards; an amount; not in the future', async () => {
    await expectDomainError(
      receiveCustomerAdvance(a.owner, {
        customerId,
        vehicleId,
        amount: '100',
        receivedOn: today(),
        method: 'CASH',
      }),
      /job card/,
    );
    await expectDomainError(
      receiveCustomerAdvance(a.owner, {
        customerId,
        jobCardId,
        vehicleId: strangerVehicleId,
        amount: '100',
        receivedOn: today(),
        method: 'CASH',
      }),
      /different vehicle/,
    );
    await expectDomainError(
      receiveCustomerAdvance(a.owner, {
        customerId: strangerId,
        jobCardId,
        amount: '100',
        receivedOn: today(),
        method: 'CASH',
      }),
      /this customer’s job cards/,
    );
    await expectDomainError(
      receiveCustomerAdvance(a.owner, {
        customerId,
        jobCardId,
        amount: '0',
        receivedOn: today(),
        method: 'CASH',
      }),
      /above zero/,
    );
    await expectDomainError(
      receiveCustomerAdvance(a.owner, {
        customerId,
        jobCardId,
        amount: '10',
        receivedOn: '2999-01-01',
        method: 'CASH',
      }),
      /future/,
    );
  });

  test('someone who may only look cannot take or see advances', async () => {
    await assert.rejects(
      receiveCustomerAdvance(a.viewer, {
        customerId,
        jobCardId,
        amount: '10',
        receivedOn: today(),
        method: 'CASH',
      }),
      AuthError,
    );
    await assert.rejects(getCustomerAdvance(a.viewer, advanceId), AuthError);
  });
});

describe('applying advances to invoices', () => {
  let advanceId: string;
  let invoiceId: string;
  let firstApplication: string;
  let secondApplication: string;

  before(async () => {
    advanceId = (
      await prisma.customerAdvance.findFirstOrThrow({
        where: { organizationId: a.organizationId, jobCardId },
      })
    ).id;
    // The job's invoice: labour 1,000 + VAT 50 = 1,050.
    invoiceId = await labourInvoice('1000', { jobCardId });
  });

  test('part applied: Dr Customer advances and its VAT released, Cr receivables — the invoice untouched', async () => {
    const before = await bookedFor(invoiceId);
    const { allocationId } = await applyCustomerAdvance(a.owner, advanceId, {
      invoiceId,
      amount: '600',
    });
    firstApplication = allocationId;
    const booked = await bookedFor(allocationId);
    // 600 of 2,000: 28.57 of its 95.24 VAT, accounted when received, comes off.
    assert.equal(booked.get(roles.CUSTOMER_ADVANCES), toFils('571.43'));
    assert.equal(booked.get(roles.VAT_OUTPUT), toFils('28.57'));
    assert.equal(booked.get(roles.ACCOUNTS_RECEIVABLE), -toFils('600.00'));
    assert.equal(booked.size, 3);
    assert.deepEqual(await bookedFor(invoiceId), before, 'the invoice’s own entry is unchanged');

    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.taxAmount.toString(), '50');
    assert.equal(invoice.totalAmount.toString(), '1050');
    assert.equal(invoice.advanceAppliedAmount.toString(), '600');
    assert.equal(invoice.status, 'PARTIALLY_PAID');
    const detail = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(detail.advanceApplied, '600.00');
    assert.equal(detail.paidAmount, '0.00');
    assert.equal(detail.balanceDue, '450.00', '1,050 − 600');
    assert.equal((await advanceOf(advanceId)).figures.left, '1400.00');
    assert.equal((await advanceOf(advanceId)).status, 'PARTIALLY_APPLIED');
  });

  test('never more than is due', async () => {
    await expectDomainError(
      applyCustomerAdvance(a.owner, advanceId, { invoiceId, amount: '450.01' }),
      /Only 450\.00 is due/,
    );
  });

  test('the rest settles the invoice and moves the job card to Paid', async () => {
    const { allocationId } = await applyCustomerAdvance(a.owner, advanceId, {
      invoiceId,
      amount: '450',
    });
    secondApplication = allocationId;
    assert.equal((await invoiceOf(invoiceId)).status, 'PAID');
    assert.equal(
      (await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } })).status,
      'PAID',
    );
    await expectDomainError(
      applyCustomerAdvance(a.owner, advanceId, { invoiceId, amount: '1' }),
      /already fully paid/,
    );
  });

  test('undone: kept on record, entry reversed, owed again, job back to Invoiced', async () => {
    await undoAdvanceApplication(a.owner, secondApplication, { reason: 'Wrong amount' });
    const row = await prisma.customerAdvanceAllocation.findUniqueOrThrow({
      where: { id: secondApplication },
    });
    assert.ok(row.reversedAt);
    assert.equal((await bookedFor(secondApplication)).size, 0, 'nothing stands');
    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.advanceAppliedAmount.toString(), '600');
    assert.equal(invoice.status, 'PARTIALLY_PAID');
    assert.equal(
      (await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } })).status,
      'INVOICED',
    );
    assert.equal((await advanceOf(advanceId)).figures.left, '1400.00');
    await expectDomainError(
      undoAdvanceApplication(a.owner, secondApplication, { reason: 'Again' }),
      /already been undone/,
    );
    // Applied again, correctly this time.
    await applyCustomerAdvance(a.owner, advanceId, { invoiceId, amount: '450' });
    assert.equal((await invoiceOf(invoiceId)).status, 'PAID');
    assert.ok(firstApplication);
  });

  test('an invoice with an advance applied is not voided until the advance is undone', async () => {
    const small = await labourInvoice('100');
    const { allocationId } = await applyCustomerAdvance(a.owner, advanceId, {
      invoiceId: small,
      amount: '50',
    });
    await expectDomainError(
      voidInvoice(a.owner, small, { reason: 'Raised in error' }),
      /customer advance has been applied/,
    );
    await undoAdvanceApplication(a.owner, allocationId, { reason: 'Raised in error' });
    await voidInvoice(a.owner, small, { reason: 'Raised in error' });
    assert.equal((await invoiceOf(small)).status, 'VOID');
  });

  test('not to another customer’s invoice', async () => {
    const { invoiceId: theirs } = await createDirectInvoice(a.owner, {
      customerId: strangerId,
      items: [{ itemType: 'LABOUR', description: 'Wash', quantity: '1', unitPrice: '20' }],
    });
    await expectDomainError(
      applyCustomerAdvance(a.owner, advanceId, { invoiceId: theirs, amount: '10' }),
      /different customer/,
    );
  });
});

describe('several advances, one invoice — and a credit note', () => {
  let bigAdvance: string;
  let bankAdvance: string;
  let invoiceId: string;
  let creditNoteId: string;

  before(async () => {
    bigAdvance = (
      await prisma.customerAdvance.findFirstOrThrow({
        where: { organizationId: a.organizationId, jobCardId },
      })
    ).id;
    bankAdvance = (
      await receiveCustomerAdvance(a.owner, {
        customerId,
        jobCardId,
        amount: '300',
        receivedOn: today(),
        method: 'BANK_TRANSFER',
      })
    ).id;
    // Labour 500 + VAT 25 = 525.
    invoiceId = await labourInvoice('500');
  });

  test('200 + 300 from two advances and 25 in cash settle 525', async () => {
    await applyCustomerAdvance(a.owner, bigAdvance, { invoiceId, amount: '200' });
    await applyCustomerAdvance(a.owner, bankAdvance, { invoiceId, amount: '300' });
    assert.equal((await getInvoiceDetail(a.owner, invoiceId)).balanceDue, '25.00');
    await recordInvoicePayment(a.owner, invoiceId, {
      amount: '25',
      method: 'CASH',
      receivedAt: toLocalDateTimeInput(new Date()),
    });
    const detail = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(detail.balanceDue, '0.00');
    assert.equal(detail.status, 'PAID');
    assert.equal((await advanceOf(bankAdvance)).status, 'FULLY_APPLIED');
    // Two separate guards. A settled invoice takes nothing more from any
    // advance — checked first, since it holds whatever the advance has left.
    await expectDomainError(
      applyCustomerAdvance(a.owner, bigAdvance, { invoiceId, amount: '1' }),
      /already fully paid/,
    );
    // An advance with nothing left can't be applied, even to an invoice that
    // still has money due.
    const stillOwed = await labourInvoice('40');
    await expectDomainError(
      applyCustomerAdvance(a.owner, bankAdvance, { invoiceId: stillOwed, amount: '1' }),
      /Only 0\.00 is left/,
    );
    assert.equal((await getInvoiceDetail(a.owner, stillOwed)).balanceDue, '42.00');
  });

  test('a credit note gives the over-settled money back to the advance, not as cash', async () => {
    const creditable = await getCreditableInvoice(a.owner, invoiceId);
    // 100 before VAT = 105 with it.
    const note = await createCreditNote(a.owner, invoiceId, {
      reason: 'Agreed discount after the job',
      lines: [{ invoiceItemId: creditable.lines[0].id, amount: '100' }],
    });
    creditNoteId = note.creditNoteId;
    assert.equal(note.refundAmount, '0.00', 'no cash refund');
    assert.equal(note.returnedToAdvances, '105.00');
    // Newest application first: the bank advance's 300.
    assert.equal((await advanceOf(bankAdvance)).figures.left, '105.00');
    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.advanceAppliedAmount.toString(), '395');
    assert.equal(invoice.creditedAmount.toString(), '105');
    assert.equal(invoice.status, 'PAID', '525 − 105 − 395 − 25 = 0');
    const returned = await prisma.customerAdvanceAllocation.findFirstOrThrow({
      where: { creditNoteId },
    });
    assert.equal(returned.amount.toString(), '-105');
    const booked = await bookedFor(returned.id);
    assert.equal(booked.get(roles.ACCOUNTS_RECEIVABLE), toFils('105.00'));
    // Held again as an advance: its VAT is accounted again, as on receipt.
    assert.equal(
      (booked.get(roles.CUSTOMER_ADVANCES) ?? 0) + (booked.get(roles.VAT_OUTPUT) ?? 0),
      -toFils('105.00'),
    );
    assert.ok((booked.get(roles.VAT_OUTPUT) ?? 0) < 0, 'VAT accounted again');
  });

  test('voiding the credit note applies the money to the invoice again', async () => {
    await voidCreditNote(a.owner, creditNoteId, { reason: 'Issued in error' });
    assert.equal((await advanceOf(bankAdvance)).figures.left, '0.00');
    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.advanceAppliedAmount.toString(), '500');
    assert.equal(invoice.status, 'PAID');
  });

  test('but not once the returned money has been refunded', async () => {
    const creditable = await getCreditableInvoice(a.owner, invoiceId);
    const note = await createCreditNote(a.owner, invoiceId, {
      reason: 'Agreed discount after the job',
      lines: [{ invoiceItemId: creditable.lines[0].id, amount: '100' }],
    });
    await refundCustomerAdvance(a.owner, bankAdvance, {
      amount: '105',
      refundedOn: today(),
      method: 'BANK_TRANSFER',
    });
    await expectDomainError(
      voidCreditNote(a.owner, note.creditNoteId, { reason: 'Issued in error' }),
      /has since been used/,
    );
    assert.equal((await advanceOf(bankAdvance)).status, 'REFUNDED');
  });
});

describe('refunds and cancelling', () => {
  let advanceId: string;

  before(async () => {
    advanceId = (
      await prisma.customerAdvance.findFirstOrThrow({
        where: { organizationId: a.organizationId, jobCardId },
      })
    ).id;
  });

  test('part refunded from the bank, then the refund reversed', async () => {
    const left = (await advanceOf(advanceId)).figures.left;
    const { refundId } = await refundCustomerAdvance(a.owner, advanceId, {
      amount: '250',
      refundedOn: today(),
      method: 'BANK_TRANSFER',
    });
    const booked = await bookedFor(refundId);
    // Paid back: the advance (net) and the VAT on it both come off.
    assert.equal(
      (booked.get(roles.CUSTOMER_ADVANCES) ?? 0) + (booked.get(roles.VAT_OUTPUT) ?? 0),
      toFils('250.00'),
    );
    assert.ok((booked.get(roles.VAT_OUTPUT) ?? 0) > 0, 'its VAT released');
    assert.equal(booked.get(roles.BANK), -toFils('250.00'));
    assert.equal(
      (await advanceOf(advanceId)).figures.left,
      filsToString(toFils(left) - toFils('250')),
    );
    await reverseAdvanceRefund(a.owner, refundId, { reason: 'Paid in error' });
    assert.equal((await bookedFor(refundId)).size, 0);
    assert.equal((await advanceOf(advanceId)).figures.left, left);
  });

  test('never more than is left, and never out of card settlements', async () => {
    const left = (await advanceOf(advanceId)).figures.left;
    await expectDomainError(
      refundCustomerAdvance(a.owner, advanceId, {
        amount: filsToString(toFils(left) + 1),
        refundedOn: today(),
        method: 'CASH',
      }),
      /is left on this advance/,
    );
    await expectDomainError(
      refundCustomerAdvance(a.owner, advanceId, {
        amount: '10',
        refundedOn: today(),
        method: 'CARD',
      }),
      /Card settlements/,
    );
  });

  test('cancelled only while unused: its entry reversed, record kept', async () => {
    await expectDomainError(
      cancelCustomerAdvance(a.owner, advanceId, { reason: 'Mistake' }),
      /applied or refunded/,
    );
    const spare = await receiveCustomerAdvance(a.owner, {
      customerId,
      jobCardId,
      amount: '100',
      receivedOn: today(),
      method: 'CASH',
    });
    await cancelCustomerAdvance(a.owner, spare.id, { reason: 'Wrong customer' });
    assert.equal((await advanceOf(spare.id)).status, 'CANCELLED');
    assert.equal((await bookedFor(spare.id)).size, 0, 'nothing stands');
    const invoiceId = await labourInvoice('10');
    await expectDomainError(
      applyCustomerAdvance(a.owner, spare.id, { invoiceId, amount: '1' }),
      /cancelled/,
    );
  });
});

describe('the new invoice form', () => {
  test('the advance applied as it is issued, and only the rest taken as payment', async () => {
    const heldBefore = await customerAdvanceHeld(prisma, a.organizationId, customerId);
    await receiveCustomerAdvance(a.owner, {
      customerId,
      jobCardId,
      amount: '100',
      receivedOn: today(),
      method: 'CASH',
    });
    // Labour 300 + VAT 15 = 315: 100 from the advance, 215 paid on the spot.
    const { invoiceId, paymentId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '300' }],
      applyAdvance: '1',
      advanceAmount: '100',
      payNow: '1',
      paymentMethod: 'CASH',
    });
    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.taxAmount.toString(), '15', 'VAT on the full sale');
    assert.equal(invoice.totalAmount.toString(), '315');
    assert.equal(invoice.advanceAppliedAmount.toString(), '100');
    assert.equal(invoice.status, 'PAID');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId! } });
    assert.equal(payment.amount.toString(), '215');
    // Applied oldest advance first; 100 in and 100 out leaves what was held before.
    assert.equal(await customerAdvanceHeld(prisma, a.organizationId, customerId), heldBefore);
  });

  test('never more than is held, nor more than the invoice', async () => {
    await expectDomainError(
      createDirectInvoice(a.owner, {
        customerId,
        items: [{ itemType: 'LABOUR', description: 'Wash', quantity: '1', unitPrice: '20' }],
        applyAdvance: '1',
        advanceAmount: '22',
      }),
      /more than the invoice total/,
    );
    await expectDomainError(
      createDirectInvoice(a.owner, {
        customerId: strangerId,
        items: [{ itemType: 'LABOUR', description: 'Wash', quantity: '1', unitPrice: '20' }],
        applyAdvance: '1',
        advanceAmount: '5',
      }),
      /Only 0\.00 is held/,
    );
  });

  test('a quotation changed on the form is billed as changed, still linked to it', async () => {
    const quote = await createQuotation(a.owner, { customerId, vehicleId });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: localDateString(new Date(Date.now() + 7 * 86400000)),
      items: [{ itemType: 'LABOUR', description: 'Alignment', quantity: '1', unitPrice: '200' }],
    });
    await sendEstimate(a.owner, quote.id);
    await recordCustomerDecision(a.owner, quote.id, { decision: 'APPROVED', method: 'PHONE' });
    // Agreed on the day: 180 instead of 200, and 10% off the bill.
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      estimateId: quote.id,
      items: [{ itemType: 'LABOUR', description: 'Alignment', quantity: '1', unitPrice: '180' }],
      discountType: 'PERCENT',
      discount: '10',
    });
    const invoice = await invoiceOf(invoiceId);
    assert.equal(invoice.subtotal.toString(), '162', '180 less 10%');
    assert.equal(invoice.taxAmount.toString(), '8.1');
    assert.equal(invoice.totalAmount.toString(), '170.1');
    const issued = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: invoiceId, action: 'invoice.issued' },
    });
    const metadata = issued.metadata as { origin?: string; estimateId?: string };
    assert.equal(metadata.origin, 'quotation_edited');
    assert.equal(metadata.estimateId, quote.id);
  });
});

describe('VAT on an advance in the return', () => {
  test('due when received, and counted once when applied to the job’s invoice', async () => {
    const period = { period: 'custom', from: today(), to: today() };
    const start = (await getVatReturn(a.owner, period)).boxes;
    const advance = await receiveCustomerAdvance(a.owner, {
      customerId,
      jobCardId,
      amount: '1050',
      receivedOn: today(),
      method: 'CASH',
    });
    const received = (await getVatReturn(a.owner, period)).boxes;
    // 1,050 = 1,000 + 50 VAT, due today.
    assert.equal(toFils(received.outputVat) - toFils(start.outputVat), toFils('50.00'));
    assert.equal(
      toFils(received.standardSupplies) - toFils(start.standardSupplies),
      toFils('1000.00'),
    );

    // Invoiced (1,000 + 50 VAT) and the advance applied in full.
    const invoiceId = await labourInvoice('1000');
    await applyCustomerAdvance(a.owner, advance.id, { invoiceId, amount: '1050' });
    const billed = await getVatReturn(a.owner, period);
    // Only one supply of 1,000 and one 50 of VAT in all: not two.
    assert.equal(toFils(billed.boxes.outputVat) - toFils(start.outputVat), toFils('50.00'));
    assert.equal(
      toFils(billed.boxes.standardSupplies) - toFils(start.standardSupplies),
      toFils('1000.00'),
    );
    assert.ok(billed.advances.some((row) => row.number === advance.advanceNumber && row.sign < 0));
  });
});

describe('everything agrees', () => {
  test('the statement shows each application, and what is still held', async () => {
    const statement = await getCustomerStatement(a.owner, customerId);
    assert.ok(statement.lines.some((line) => line.kind === 'Advance applied'));
    // Money a credit note gave back to the advance: owed on the invoice again.
    const returned = statement.lines.find((line) => line.kind === 'Returned to advance');
    assert.ok(returned, 'the return is on the statement');
    assert.equal(returned.debit, '105.00');
    assert.equal(returned.credit, '');
    const held = await customerAdvanceHeld(prisma, a.organizationId, customerId);
    assert.equal(statement.advanceHeld, filsToString(held));
    // A customer with nothing held reads AED 0, not an error.
    assert.equal((await getCustomerStatement(a.owner, strangerId)).advanceHeld, '0.00');
  });

  test('Customer advances in the books, with the VAT still on them, equals what is held', async () => {
    const lines = await prisma.journalEntryLine.findMany({
      where: { organizationId: a.organizationId, chartOfAccountId: roles.CUSTOMER_ADVANCES },
      select: { debitAmount: true, creditAmount: true },
    });
    const credit = lines.reduce(
      (sum, line) =>
        sum + toFils(line.creditAmount.toString()) - toFils(line.debitAmount.toString()),
      0,
    );
    const held =
      (await customerAdvanceHeld(prisma, a.organizationId, customerId)) +
      (await customerAdvanceHeld(prisma, a.organizationId, strangerId));
    // The VAT accounted on receipt and not yet released by an application or refund.
    const advances = await prisma.customerAdvance.findMany({
      where: { organizationId: a.organizationId, status: { not: 'CANCELLED' } },
      select: { id: true, vatAmount: true },
    });
    let vatHeld = 0;
    for (const advance of advances) {
      const released = await advanceVatReleases(prisma, a.organizationId, advance.id);
      vatHeld +=
        toFils(advance.vatAmount.toString()) -
        [...(released?.values() ?? [])].reduce((sum, value) => sum + value, 0);
    }
    assert.equal(credit + vatHeld, held);
  });

  test('the balance sheet balances and nothing is left unbooked', async () => {
    assert.equal((await getBalanceSheet(a.owner)).balanced, true);
    assert.equal(await countUnbooked(a.owner), 0);
  });
});
