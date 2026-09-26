/**
 * Integration tests for correcting mistakes: editing and voiding invoices,
 * reversing payments, deleting (archiving) customers and vehicles, fixing a
 * job card's request and mileage, and deleting an unsent draft quotation.
 *
 * The rule under all of them: nothing billed or paid is rewritten silently.
 * Money received must be reversed before its invoice changes; every change
 * is audited; records with history are archived, never destroyed.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { checkInVehicle } from '@/lib/workshop/check-in';
import {
  createQuotation,
  deleteDraftQuotation,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { getInvoiceDetail, recordInvoicePayment } from '@/lib/billing/invoice';
import { reverseInvoicePayment, updateInvoice, voidInvoice } from '@/lib/billing/invoice-changes';
import {
  archiveCustomer,
  archiveVehicle,
  restoreCustomer,
  restoreVehicle,
} from '@/lib/customers/archive';
import { listCustomers } from '@/lib/customers/service';
import { createVehicle, listVehicles } from '@/lib/vehicles/service';
import { updateJobCardDetails } from '@/lib/workshop/job-card-details';
import {
  changeAppointmentStatus,
  createAppointment,
  rescheduleAppointment,
} from '@/lib/appointments/service';
import { recordExpense, updateExpense, voidExpense } from '@/lib/finance/expenses';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, jobStatus, RUN, type TestOrg } from './support';

const now = () => toLocalDateTimeInput(new Date());
const money = (value: { toString(): string }) => Number(value.toString()).toFixed(2);

let a: TestOrg;
let plateSeq = 0;

async function openJob(label: string, mileage = '') {
  plateSeq += 1;
  return checkInVehicle(a.owner, {
    mode: 'new',
    customer: {
      name: `Fix ${label}`,
      phone: `050 7${String(plateSeq).padStart(2, '0')} ${String(Date.now()).slice(-4)}`,
      email: '',
    },
    vehicle: { plateNumber: `F${plateSeq} ${RUN.slice(-4)}`, make: 'Nissan', model: 'Sunny' },
    visit: { complaint: 'Oil change', mileage },
  });
}

async function jobParty(jobCardId: string) {
  return prisma.jobCard.findUniqueOrThrow({
    where: { id: jobCardId },
    select: { customerId: true, vehicleId: true },
  });
}

before(async () => {
  a = await createTestOrg('Fix');
});

after(async () => {
  await prisma.$disconnect();
});

describe('invoices', () => {
  test('an unpaid invoice can be edited: new lines, new totals, same number, audited', async () => {
    const { jobCardId } = await openJob('Edit');
    const party = await jobParty(jobCardId);
    const { invoiceId, invoiceNumber } = await createDirectInvoice(a.owner, {
      ...party,
      jobCardId,
      items: [
        {
          itemType: 'LABOUR',
          description: 'Oil change',
          quantity: '1',
          unitPrice: '100',
          taxRate: '5',
        },
      ],
    });

    // Settings change after the invoice went out; the correction picks them up.
    await prisma.organization.update({
      where: { id: a.organizationId },
      data: { legalName: 'Renamed Workshop LLC', address: 'Industrial Area 1' },
    });
    await updateInvoice(a.owner, invoiceId, {
      items: [
        {
          itemType: 'LABOUR',
          description: 'Oil change',
          quantity: '1',
          unitPrice: '100',
          taxRate: '5',
        },
        {
          itemType: 'PART',
          description: 'Oil filter',
          quantity: '2',
          unitPrice: '20',
          taxRate: '5',
        },
        {
          itemType: 'PART',
          description: 'Engine oil 4L',
          quantity: '1',
          unitPrice: '80',
          taxRate: '5',
        },
        { itemType: 'PART', description: 'Washer', quantity: '1', unitPrice: '5', taxRate: '5' },
      ],
      notes: 'Corrected',
    });
    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.invoiceNumber, invoiceNumber);
    assert.equal(invoice.items.length, 4, 'more than three lines are kept');
    assert.equal(money(invoice.subtotal), '225.00');
    assert.equal(money(invoice.totalAmount), '236.25');
    assert.equal(invoice.notes, 'Corrected');
    assert.equal(invoice.sellerLegalName, 'Renamed Workshop LLC');
    assert.equal(invoice.sellerAddress, 'Industrial Area 1');
    assert.equal(await jobStatus(jobCardId), 'INVOICED', 'the job card stays invoiced');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: invoiceId, action: 'invoice.updated' },
      select: { beforeData: true },
    });
    assert.equal((audit?.beforeData as { totalAmount: string }).totalAmount, '105');
  });

  test('a payment blocks edit and void until it is reversed; void then reopens the job card', async () => {
    const { jobCardId } = await openJob('Void');
    const party = await jobParty(jobCardId);
    const { invoiceId } = await createDirectInvoice(a.owner, {
      ...party,
      jobCardId,
      items: [
        {
          itemType: 'LABOUR',
          description: 'Brake pads',
          quantity: '1',
          unitPrice: '200',
          taxRate: '5',
        },
      ],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '100',
      method: 'CASH',
      receivedAt: now(),
    });

    await expectDomainError(
      updateInvoice(a.owner, invoiceId, {
        items: [{ itemType: 'LABOUR', description: 'x', quantity: '1', unitPrice: '1' }],
      }),
      /Reverse the payment first/,
    );
    await expectDomainError(
      voidInvoice(a.owner, invoiceId, { reason: 'Wrong job' }),
      /Reverse the payment first/,
    );

    await reverseInvoicePayment(a.owner, payment.id, { reason: 'Entered on the wrong invoice' });
    await expectDomainError(
      reverseInvoicePayment(a.owner, payment.id, { reason: 'Again' }),
      /already been reversed/,
    );
    let invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.status, 'ISSUED');
    assert.equal(invoice.paidAmount, '0.00');
    assert.equal(invoice.balanceDue, '210.00');
    // The original payment row is never edited.
    const original = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(original.status, 'COMPLETED');

    await voidInvoice(a.owner, invoiceId, { reason: 'Billed to the wrong job card' });
    invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.status, 'VOID');
    assert.equal(invoice.voidReason, 'Billed to the wrong job card');
    assert.ok(invoice.voidedAt);
    assert.equal(await jobStatus(jobCardId), 'ARRIVED', 'back to where it was billed from');

    // …and it can be invoiced again, under a new number.
    const again = await createDirectInvoice(a.owner, {
      ...party,
      jobCardId,
      items: [
        {
          itemType: 'LABOUR',
          description: 'Brake pads',
          quantity: '1',
          unitPrice: '180',
          taxRate: '5',
        },
      ],
    });
    assert.notEqual(again.invoiceId, invoiceId);
    assert.equal(await jobStatus(jobCardId), 'INVOICED');
  });

  test('reversing the payment on a paid job card puts it back to invoiced', async () => {
    const { jobCardId } = await openJob('Paid');
    const party = await jobParty(jobCardId);
    const { invoiceId } = await createDirectInvoice(a.owner, {
      ...party,
      jobCardId,
      items: [
        {
          itemType: 'LABOUR',
          description: 'Service',
          quantity: '1',
          unitPrice: '100',
          taxRate: '0',
        },
      ],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '100',
      method: 'CARD',
      receivedAt: now(),
    });
    assert.equal(await jobStatus(jobCardId), 'PAID');
    await reverseInvoicePayment(a.owner, payment.id, { reason: 'Card declined' });
    assert.equal(await jobStatus(jobCardId), 'INVOICED');
    assert.equal((await getInvoiceDetail(a.owner, invoiceId)).status, 'ISSUED');
  });

  test('voiding and reversing need their own permissions', async () => {
    const { jobCardId } = await openJob('Perm');
    const party = await jobParty(jobCardId);
    const { invoiceId } = await createDirectInvoice(a.owner, {
      ...party,
      items: [{ itemType: 'LABOUR', description: 'Check', quantity: '1', unitPrice: '50' }],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '10',
      method: 'CASH',
      receivedAt: now(),
    });
    const cashier = {
      ...a.owner,
      orgWidePermissions: new Set(['invoice.view', 'invoice.create', 'payment.create']),
    };
    await assert.rejects(
      reverseInvoicePayment(cashier, payment.id, { reason: 'Nope' }),
      (error: unknown) => error instanceof AuthError,
    );
    await reverseInvoicePayment(a.owner, payment.id, { reason: 'Test' });
    await assert.rejects(
      voidInvoice(cashier, invoiceId, { reason: 'Nope' }),
      (error: unknown) => error instanceof AuthError,
    );
    await expectDomainError(voidInvoice(a.owner, invoiceId, { reason: '' }), /Say why/);
  });
});

describe('customers and vehicles', () => {
  test('a customer with an open job card cannot be deleted', async () => {
    const { jobCardId } = await openJob('Open');
    const { customerId } = await jobParty(jobCardId);
    await expectDomainError(archiveCustomer(a.owner, customerId, {}), /open job card/);
  });

  test('delete archives the customer and their vehicles; restore brings both back', async () => {
    const customer = await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Archive Me ${RUN}`, phone: '050 999 1212' },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId: customer.id,
        plateNumber: `ARC ${RUN.slice(-4)}`,
        make: 'Kia',
        model: 'Rio',
      },
    });

    await archiveCustomer(a.owner, customer.id, { reason: 'Duplicate' });
    assert.equal(
      (await listCustomers(a.owner, '')).some((c) => c.id === customer.id),
      false,
    );
    assert.equal(
      (await listCustomers(a.owner, '', 50, true)).some((c) => c.id === customer.id),
      true,
    );
    assert.equal(
      (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isActive,
      false,
    );
    await expectDomainError(restoreVehicle(a.owner, vehicle.id), /Restore the customer first/);

    await restoreCustomer(a.owner, customer.id);
    assert.equal(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).isActive,
      true,
    );
    assert.equal(
      (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isActive,
      true,
    );
  });

  test('a deleted vehicle leaves the list and its plate says where to find it', async () => {
    const customer = await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Plate Owner ${RUN}`, phone: '050 888 1313' },
    });
    const plate = `DEL ${RUN.slice(-4)}`;
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId: customer.id,
        plateNumber: plate,
        make: 'Ford',
        model: 'Focus',
      },
    });
    await archiveVehicle(a.owner, vehicle.id, {});
    assert.equal(
      (await listVehicles(a.owner, '')).some((v) => v.id === vehicle.id),
      false,
    );
    assert.equal(
      (await listVehicles(a.owner, plate, 50, true)).some((v) => v.id === vehicle.id),
      true,
    );
    await expectDomainError(
      prisma.$transaction((tx) =>
        createVehicle(tx, a.owner, customer.id, {
          plateNumber: plate,
          make: 'Ford',
          model: 'Focus',
        }),
      ),
      /deleted vehicle has this registration/,
    );
    await restoreVehicle(a.owner, vehicle.id);
    assert.equal(
      (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isActive,
      true,
    );
  });

  test('deleting needs the edit permission', async () => {
    const customer = await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Guarded ${RUN}`, phone: '050 777 1414' },
    });
    await assert.rejects(
      archiveCustomer(a.viewer, customer.id, {}),
      (error: unknown) => error instanceof AuthError,
    );
  });
});

describe('job card details', () => {
  test('the request and mileage can be corrected, and the vehicle odometer follows', async () => {
    const { jobCardId } = await openJob('Details', '120000');
    const { vehicleId } = await jobParty(jobCardId);
    await updateJobCardDetails(a.owner, jobCardId, {
      complaint: 'Oil change and brake check',
      mileage: '12,000',
    });
    const job = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
    assert.equal(job.customerComplaint, 'Oil change and brake check');
    assert.equal(job.odometerReading, 12000);
    assert.equal(
      (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).lastMileage,
      12000,
    );
    await expectDomainError(
      updateJobCardDetails(a.owner, jobCardId, { complaint: 'x', mileage: '' }),
      /Describe the work/,
    );
  });
});

describe('draft quotations', () => {
  test('an unsent standalone draft can be deleted; a sent one cannot', async () => {
    const customer = await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Quote Person ${RUN}`,
        phone: '050 666 1515',
      },
    });
    const draft = await createQuotation(a.owner, { customerId: customer.id });
    await deleteDraftQuotation(a.owner, draft.id);
    assert.equal(await prisma.estimate.findUnique({ where: { id: draft.id } }), null);

    const sent = await createQuotation(a.owner, { customerId: customer.id });
    await saveEstimateDraft(a.owner, sent.id, {
      validUntil: localDateString(new Date(Date.now() + 7 * 86400000)),
      items: [
        {
          itemType: 'LABOUR',
          description: 'Service',
          quantity: '1',
          unitPrice: '100',
          taxRate: '5',
        },
      ],
    });
    await sendEstimate(a.owner, sent.id);
    await expectDomainError(deleteDraftQuotation(a.owner, sent.id), /never sent/);
  });
});

describe('appointments and expenses', () => {
  test('an open appointment can be moved; a cancelled one cannot', async () => {
    const { jobCardId } = await openJob('Booking');
    const { vehicleId } = await jobParty(jobCardId);
    const later = (days: number) => toLocalDateTimeInput(new Date(Date.now() + days * 86400000));
    const appointment = await createAppointment(a.owner, {
      vehicleId,
      scheduledAt: later(2),
      estimatedDurationMinutes: '60',
      notes: 'Service',
    });
    await rescheduleAppointment(a.owner, appointment.id, {
      scheduledAt: later(5),
      estimatedDurationMinutes: '120',
      notes: 'Service and AC check',
    });
    const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    assert.ok(moved.scheduledAt.getTime() > appointment.scheduledAt.getTime() + 2 * 86400000);
    assert.equal(moved.estimatedDurationMinutes, 120);
    assert.equal(moved.notes, 'Service and AC check');
    await expectDomainError(
      rescheduleAppointment(a.owner, appointment.id, { scheduledAt: later(-3), notes: 'x' }),
      /in the past/,
    );
    await changeAppointmentStatus(a.owner, appointment.id, 'CANCELLED');
    await expectDomainError(
      rescheduleAppointment(a.owner, appointment.id, { scheduledAt: later(6), notes: 'x' }),
      /can't be moved/,
    );
  });

  test('a recorded expense can be corrected, VAT re-split; a voided one cannot', async () => {
    const expense = await recordExpense(a.owner, {
      description: 'Rent',
      amount: '1000.00',
      taxRate: '5',
      expenseDate: localDateString(),
      paymentMethod: 'CASH',
    });
    await updateExpense(a.owner, expense.id, {
      description: 'Workshop rent — September',
      amount: '1200.00',
      taxRate: '5',
      expenseDate: localDateString(),
      paymentMethod: 'BANK_TRANSFER',
    });
    const fixed = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    assert.equal(fixed.description, 'Workshop rent — September');
    assert.equal(money(fixed.amount), '1200.00');
    assert.equal(money(fixed.taxAmount!), '60.00');
    assert.equal(fixed.paymentMethod, 'BANK_TRANSFER');
    await voidExpense(a.owner, expense.id, { reason: 'Duplicate' });
    await expectDomainError(
      updateExpense(a.owner, expense.id, {
        description: 'x y',
        amount: '1.00',
        expenseDate: localDateString(),
      }),
      /voided expense/,
    );
  });
});
