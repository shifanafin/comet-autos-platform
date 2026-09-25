/**
 * End-to-end integration tests for the core workshop journey, run against
 * the local PostgreSQL database through the real service layer:
 *
 *   customer → vehicle → appointment → check-in → job card → technician →
 *   inspection → diagnosis → estimate → send → customer link → approval
 *
 * plus the invalid cases (duplicates, bad input, permissions, tokens,
 * illegal status transitions).
 *
 * Every run creates its own throwaway organizations, so the real Comet Autos
 * data is never touched and runs never interfere with each other.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/authorize';
import { DomainError } from '@/lib/errors';
import { createCustomer, updateCustomer, listCustomers } from '@/lib/customers/service';
import { createVehicle, updateVehicle, listVehicles, getVehicleDetail } from '@/lib/vehicles/service';
import { createAppointment, changeAppointmentStatus } from '@/lib/appointments/service';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { assignPrimaryTechnician } from '@/lib/workshop/assignment';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  saveEstimateDraft,
  sendEstimate,
  reviseEstimate,
  recordCustomerDecision,
} from '@/lib/workshop/estimates';
import { getJobWorkspace, getNextAction } from '@/lib/workshop/workspace';
import { transitionJobStatus } from '@/lib/workshop/job-status';
import { getQuoteAccess, loadCustomerQuote, decideQuoteAsCustomer } from '@/lib/customer-access/quote';
import { hashToken } from '@/lib/customer-access/tokens';
import { toLocalDateTimeInput, localDateString } from '@/lib/format';
import { resolveDefaultVatRate, UAE_STANDARD_VAT_RATE } from '@/lib/tax';

const RUN = Date.now().toString(36).toUpperCase();
const ALL_PERMISSIONS = [
  'job_card.view',
  'job_card.create',
  'job_card.edit',
  'job_card.assign',
  'job_card.close',
  'customer.view',
  'customer.create',
  'customer.edit',
  'vehicle.view',
  'vehicle.create',
  'vehicle.edit',
];

interface TestOrg {
  owner: AuthenticatedUser;
  viewer: AuthenticatedUser;
  technicianIds: string[];
}

async function createTestOrg(label: string): Promise<TestOrg> {
  const org = await prisma.organization.create({
    data: { name: `Test ${label} ${RUN}`, phone: '04 000 0000', address: 'Test address' },
  });
  const branch = await prisma.branch.create({
    data: { organizationId: org.id, code: 'T', name: 'Test branch' },
  });
  const makeUser = async (email: string) =>
    prisma.user.create({
      data: {
        organizationId: org.id,
        primaryBranchId: branch.id,
        email,
        passwordHash: 'not-used',
        fullName: `${label} ${email.split('@')[0]}`,
      },
    });
  const ownerUser = await makeUser('owner@test.local');
  const viewerUser = await makeUser('viewer@test.local');
  const technicians = await Promise.all(
    ['Tech One', 'Tech Two'].map((name, index) =>
      prisma.employee.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          employeeCode: `T-${index}`,
          firstName: name.split(' ')[0],
          lastName: name.split(' ')[1],
          hireDate: new Date('2024-01-01T00:00:00Z'),
        },
      }),
    ),
  );

  const base = { organizationId: org.id, primaryBranchId: branch.id, roleNames: [] as string[], branchPermissions: new Map<string, Set<string>>() };
  return {
    owner: { ...base, id: ownerUser.id, email: ownerUser.email, fullName: ownerUser.fullName, orgWidePermissions: new Set(ALL_PERMISSIONS) },
    viewer: {
      ...base,
      id: viewerUser.id,
      email: viewerUser.email,
      fullName: viewerUser.fullName,
      orgWidePermissions: new Set(['job_card.view', 'customer.view', 'vehicle.view']),
    },
    technicianIds: technicians.map((t) => t.id),
  };
}

async function expectDomainError(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

const jobStatus = async (id: string) =>
  (await prisma.jobCard.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const auditActions = async (organizationId: string, entityId: string) =>
  (await prisma.auditLog.findMany({ where: { organizationId, entityId }, orderBy: { createdAt: 'asc' } })).map(
    (row) => row.action,
  );

let a: TestOrg;
let b: TestOrg;

before(async () => {
  a = await createTestOrg('A');
  b = await createTestOrg('B');
});

after(async () => {
  await prisma.$disconnect();
});

describe('core workshop journey', () => {
  const plate = `T ${RUN.slice(-5)}`;
  const vin = `JTM${RUN}`.slice(0, 17);
  let customerId: string;
  let vehicleId: string;
  let jobCardId: string;
  let estimateId: string;
  let rawToken: string;

  test('1. create customer (and reject bad input)', async () => {
    await expectDomainError(
      prisma.$transaction((tx) => createCustomer(tx, a.owner, { name: 'Test', phone: '12' })),
      /complete mobile number/,
    );
    await expectDomainError(
      prisma.$transaction((tx) => createCustomer(tx, a.owner, { name: '', phone: '050 123 4567' })),
      /name is required/,
    );
    const customer = await prisma.$transaction((tx) =>
      createCustomer(tx, a.owner, { name: 'Mariam Test', phone: '  050  765 4321 ', email: '' }),
    );
    customerId = customer.id;
    assert.equal(customer.phone, '050 765 4321');

    const edited = await updateCustomer(a.owner, customerId, {
      name: 'Mariam Al Test',
      phone: '050 765 4321',
      email: 'mariam@test.local',
    });
    assert.equal(edited.name, 'Mariam Al Test');
    assert.deepEqual(await auditActions(a.owner.organizationId, customerId), ['customer.created', 'customer.updated']);
  });

  test('2. add vehicle (duplicates and missing customer are rejected)', async () => {
    await expectDomainError(
      prisma.$transaction((tx) => createVehicle(tx, a.owner, undefined, { plateNumber: 'X 1', make: 'Kia', model: 'Rio' })),
      /Choose the customer/,
    );
    const vehicle = await prisma.$transaction((tx) =>
      createVehicle(tx, a.owner, customerId, {
        plateNumber: plate.toLowerCase(),
        plateEmirate: 'Dubai',
        vin: vin.toLowerCase(),
        make: 'Toyota',
        model: 'Camry',
        year: '2022',
      }),
    );
    vehicleId = vehicle.id;
    assert.equal(vehicle.plateNumber, plate.toUpperCase());
    assert.equal(vehicle.vin, vin.toUpperCase());

    await expectDomainError(
      prisma.$transaction((tx) =>
        createVehicle(tx, a.owner, customerId, { plateNumber: plate.replace(' ', ''), make: 'Kia', model: 'Rio' }),
      ),
      /registration is already on file/,
    );
    await expectDomainError(
      prisma.$transaction((tx) =>
        createVehicle(tx, a.owner, customerId, { plateNumber: `Z ${RUN.slice(-4)}`, vin, make: 'Kia', model: 'Rio' }),
      ),
      /VIN is already on file/,
    );
    await expectDomainError(
      updateVehicle(a.owner, vehicleId, { plateNumber: plate, make: 'Toyota', model: 'Camry', year: '1800' }),
      /realistic model year/,
    );

    // Same registration is fine in a different organization.
    const otherCustomer = await prisma.$transaction((tx) => createCustomer(tx, b.owner, { name: 'Other', phone: '0501111111' }));
    await prisma.$transaction((tx) =>
      createVehicle(tx, b.owner, otherCustomer.id, { plateNumber: plate, make: 'Kia', model: 'Rio' }),
    );
  });

  test('3. search by name, mobile (any format), registration and VIN', async () => {
    for (const query of ['mariam', '+971 50 765 4321', '0507654321', plate.replace(' ', '').toLowerCase(), vin.slice(-8)]) {
      const customers = await listCustomers(a.owner, query);
      assert.ok(customers.some((c) => c.id === customerId), `customer search "${query}"`);
    }
    const vehicles = await listVehicles(a.owner, plate.replace(' ', ''));
    assert.equal(vehicles[0]?.id, vehicleId);
    // Tenant isolation: org B has a vehicle with the same plate, and neither org sees the other's.
    assert.ok(vehicles.every((v) => v.organizationId === a.owner.organizationId));
    assert.equal((await listVehicles(b.owner, plate)).some((v) => v.id === vehicleId), false);
  });

  test('4. appointment → check-in creates the job card as Arrived', async () => {
    const tomorrow = toLocalDateTimeInput(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await expectDomainError(
      createAppointment(a.owner, { vehicleId, scheduledAt: '2020-01-01T09:00', notes: 'Service' }),
      /in the past/,
    );
    const appointment = await createAppointment(a.owner, {
      vehicleId,
      scheduledAt: tomorrow,
      estimatedDurationMinutes: '60',
      notes: 'AC not cooling',
    });
    await changeAppointmentStatus(a.owner, appointment.id, 'CONFIRMED');

    const visit = (overrides: Record<string, string>) => ({ complaint: 'AC not cooling', mileage: '45000', appointmentId: appointment.id, ...overrides });
    await expectDomainError(checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: visit({ complaint: '  ' }) }), /Describe the work/);
    await expectDomainError(checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: visit({ mileage: 'abc' }) }), /whole number/);
    await expectDomainError(checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: visit({ mileage: '-5' }) }), /whole number/);
    await expectDomainError(checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: visit({ mileage: '99999999' }) }), /not realistic/);
    await expectDomainError(
      checkInVehicle(b.owner, { mode: 'existing', vehicleId, visit: visit({ appointmentId: '' }) }),
      /Choose the vehicle/,
    );

    const result = await checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: visit({ mileage: '45,000' }) });
    jobCardId = result.jobCardId;
    assert.match(result.jobNumber, /^JC-\d{6}$/);

    const job = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId }, include: { vehicle: true } });
    assert.equal(job.status, 'ARRIVED');
    assert.equal(job.vehicle.customerId, customerId);
    assert.equal(job.appointmentId, appointment.id);
    assert.equal(job.odometerReading, 45000);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status, 'CHECKED_IN');
    assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).lastMileage, 45000);
    assert.deepEqual(await auditActions(a.owner.organizationId, jobCardId), ['job_card.created']);

    await expectDomainError(
      checkInVehicle(a.owner, { mode: 'existing', vehicleId, visit: { complaint: 'Again', mileage: '46000' } }),
      /already in the workshop/,
    );
  });

  test('5. walk-in with a brand-new customer, and mileage lower than last reading', async () => {
    const walkIn = await checkInVehicle(a.owner, {
      mode: 'new',
      customer: { name: 'Walk In', phone: '055 222 3344' },
      vehicle: { plateNumber: `W ${RUN.slice(-5)}`, make: 'Nissan', model: 'Sunny' },
      visit: { complaint: 'Brake noise', mileage: '120000' },
    });
    const job = await prisma.jobCard.findUniqueOrThrow({ where: { id: walkIn.jobCardId }, include: { vehicle: { include: { customer: true } } } });
    assert.equal(job.vehicle.customer.name, 'Walk In');
    assert.equal(job.appointmentId, null);

    await prisma.$transaction((tx) => transitionJobStatus(tx, a.owner, walkIn.jobCardId, 'CANCELLED'));
    await expectDomainError(
      checkInVehicle(a.owner, { mode: 'existing', vehicleId: job.vehicleId, visit: { complaint: 'Back again', mileage: '119000' } }),
      /lower than the last recorded reading/,
    );
    // Nothing half-created: a failed new-customer check-in rolls the customer back.
    const before = await prisma.customer.count({ where: { organizationId: a.owner.organizationId } });
    await expectDomainError(
      checkInVehicle(a.owner, {
        mode: 'new',
        customer: { name: 'Ghost', phone: '055 999 8877' },
        vehicle: { plateNumber: plate, make: 'X', model: 'Y' },
        visit: { complaint: 'Anything', mileage: '10' },
      }),
      /already on file/,
    );
    assert.equal(await prisma.customer.count({ where: { organizationId: a.owner.organizationId } }), before);
  });

  test('6. assign technician and reject invalid status transitions', async () => {
    let workspace = await getJobWorkspace(a.owner, jobCardId);
    assert.equal(getNextAction(workspace).title, 'Assign a technician');

    await assignPrimaryTechnician(a.owner, jobCardId, a.technicianIds[0]);
    await assignPrimaryTechnician(a.owner, jobCardId, a.technicianIds[1]);
    const assignments = await prisma.jobAssignment.findMany({ where: { jobCardId }, orderBy: { assignedAt: 'asc' } });
    assert.equal(assignments.length, 2);
    assert.ok(assignments[0].unassignedAt, 'previous primary is closed, not deleted');
    assert.equal(assignments[1].unassignedAt, null);
    await expectDomainError(assignPrimaryTechnician(a.owner, jobCardId, b.technicianIds[0]), /active technician/);

    workspace = await getJobWorkspace(a.owner, jobCardId);
    assert.equal(getNextAction(workspace).title, 'Inspect the vehicle');

    await expectDomainError(prisma.$transaction((tx) => transitionJobStatus(tx, a.owner, jobCardId, 'DIAGNOSIS')), /can't move/);
    await expectDomainError(prisma.$transaction((tx) => transitionJobStatus(tx, a.owner, jobCardId, 'INSPECTION')), /Start the inspection/);
    await expectDomainError(prisma.$transaction((tx) => transitionJobStatus(tx, a.owner, jobCardId, 'APPROVED')), /can't move/);
    await expectDomainError(
      saveDiagnosis(a.owner, jobCardId, { employeeId: a.technicianIds[1], findings: 'x x x', recommendedAction: 'y y y' }),
      /Inspect the vehicle/,
    );
    assert.equal(await jobStatus(jobCardId), 'ARRIVED');
  });

  test('7. inspection with findings', async () => {
    const inspection = await startInspection(a.owner, jobCardId, a.technicianIds[1]);
    assert.equal(await jobStatus(jobCardId), 'INSPECTION');
    await expectDomainError(startInspection(a.owner, jobCardId, a.technicianIds[1]), /just arrived/);

    await expectDomainError(
      saveInspection(a.owner, inspection.id, { items: [] }, { complete: true }),
      /at least one checkpoint/,
    );
    await expectDomainError(
      saveInspection(a.owner, inspection.id, { items: [{ description: 'Air conditioning', result: 'FAILED' }] }, { complete: false }),
      /Describe what you found/,
    );
    await saveInspection(
      a.owner,
      inspection.id,
      {
        items: [
          { category: 'Interior', description: 'Air conditioning', result: 'FAILED', notes: 'Vent temp 22°C, compressor clutch not engaging' },
          { category: 'Tyres and brakes', description: 'Brake pads and discs', result: 'ATTENTION_NEEDED', notes: 'Front pads at 3mm' },
          { category: 'Under the bonnet', description: 'Engine oil', result: 'OK' },
          { category: 'Exterior', description: 'Wipers', result: 'NOT_CHECKED' },
        ],
      },
      { complete: false },
    );
    assert.equal(await prisma.inspectionItem.count({ where: { inspectionId: inspection.id } }), 3, 'not-checked is not stored');

    await expectDomainError(
      saveDiagnosis(a.owner, jobCardId, { employeeId: a.technicianIds[1], findings: 'x x x', recommendedAction: 'y y y' }),
      /Complete the inspection/,
    );

    await saveInspection(
      a.owner,
      inspection.id,
      {
        summary: 'AC compressor fault, front pads worn',
        items: [
          { category: 'Interior', description: 'Air conditioning', result: 'FAILED', notes: 'Compressor clutch not engaging' },
          { category: 'Tyres and brakes', description: 'Brake pads and discs', result: 'ATTENTION_NEEDED', notes: 'Front pads at 3mm' },
          { category: 'Under the bonnet', description: 'Engine oil', result: 'OK' },
        ],
      },
      { complete: true },
    );
    await expectDomainError(saveInspection(a.owner, inspection.id, { items: [] }, { complete: false }), /already complete/);
    assert.deepEqual(await auditActions(a.owner.organizationId, inspection.id), ['inspection.started', 'inspection.completed']);
  });

  test('8. diagnosis', async () => {
    await expectDomainError(
      saveDiagnosis(a.owner, jobCardId, { employeeId: a.technicianIds[1], findings: '', recommendedAction: 'Replace' }),
      /Describe the diagnosis/,
    );
    await saveDiagnosis(a.owner, jobCardId, {
      employeeId: a.technicianIds[1],
      findings: 'AC compressor clutch coil open circuit',
      recommendedAction: 'Replace compressor clutch, recharge gas; replace front brake pads',
    });
    assert.equal(await jobStatus(jobCardId), 'DIAGNOSIS');
    // Correction while still diagnosed updates in place.
    await saveDiagnosis(a.owner, jobCardId, {
      employeeId: a.technicianIds[1],
      findings: 'AC compressor clutch coil open circuit (confirmed with meter)',
      recommendedAction: 'Replace compressor clutch, recharge gas; replace front brake pads',
    });
    assert.equal(await prisma.diagnosis.count({ where: { jobCardId } }), 1);
    const workspace = await getJobWorkspace(a.owner, jobCardId);
    assert.equal(getNextAction(workspace).title, 'Create the estimate');
  });

  test('9. estimate with labour, parts and VAT', async () => {
    const estimate = await createEstimate(a.owner, jobCardId);
    estimateId = estimate.id;
    assert.match(estimate.estimateNumber, /^EST-\d{6}$/);
    assert.equal((await createEstimate(a.owner, jobCardId)).id, estimateId, 'reopens the same draft');
    assert.equal(await jobStatus(jobCardId), 'ESTIMATE');
    assert.equal(getNextAction(await getJobWorkspace(a.owner, jobCardId)).title, 'Finish and send the estimate');
    assert.equal(await resolveDefaultVatRate(a.owner.organizationId), UAE_STANDARD_VAT_RATE);

    await expectDomainError(sendEstimate(a.owner, estimateId), /at least one/);
    await expectDomainError(
      saveEstimateDraft(a.owner, estimateId, {
        validUntil: localDateString(),
        items: [{ itemType: 'PART', description: 'Pads', quantity: '0', unitPrice: '10' }],
      }),
      /greater than zero/,
    );

    const validUntil = localDateString(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const saved = await saveEstimateDraft(a.owner, estimateId, {
      validUntil,
      items: [
        { itemType: 'LABOUR', description: 'Replace AC compressor clutch', quantity: '2.5', unitPrice: '150', taxRate: '5' },
        { itemType: 'PART', description: 'AC compressor clutch assembly', quantity: '1', unitPrice: '480.00' },
        { itemType: 'PART', description: 'Front brake pads', quantity: '4', unitPrice: '32.50' },
        { itemType: 'LABOUR', description: 'AC gas recharge', quantity: '1', unitPrice: '99.99' },
      ],
    });
    // Lines without a rate take the organization default (lib/tax.ts), stored on the line.
    const stored = await prisma.estimateItem.findMany({ where: { estimateId } });
    assert.ok(stored.every((item) => item.taxRate?.toString() === '5'));
    // 375.00 + 480.00 + 130.00 + 99.99 = 1084.99; VAT per line 18.75 + 24.00 + 6.50 + 5.00 = 54.25
    assert.equal(saved.subtotal.toString(), '1084.99');
    assert.equal(saved.taxAmount.toString(), '54.25');
    assert.equal(saved.totalAmount.toString(), '1139.24');
  });

  test('10. send estimate issues a secure link and waits for approval', async () => {
    const sent = await sendEstimate(a.owner, estimateId);
    rawToken = sent.rawToken;
    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await jobStatus(jobCardId), 'WAITING_APPROVAL');
    const stored = await prisma.customerAccessToken.findFirstOrThrow({ where: { resourceId: estimateId } });
    assert.equal(stored.tokenHash, hashToken(rawToken));
    assert.notEqual(stored.tokenHash, rawToken, 'raw token is never stored');
    await expectDomainError(sendEstimate(a.owner, estimateId), /already been sent/);
    await expectDomainError(
      saveEstimateDraft(a.owner, estimateId, { validUntil: localDateString(), items: [] }),
      /can no longer be edited/,
    );
    const workspace = await getJobWorkspace(a.owner, jobCardId);
    assert.equal(getNextAction(workspace).title, 'Waiting for customer approval');
  });

  test('11. customer link: opens with one tap, and only its own quotation', async () => {
    assert.equal((await getQuoteAccess('not-a-real-token')).state, 'invalid');
    // One character off is a different (unknown) link.
    assert.equal((await getQuoteAccess(rawToken.slice(0, -1) + (rawToken.endsWith('A') ? 'B' : 'A'))).state, 'invalid');
    assert.equal((await getQuoteAccess('x'.repeat(43))).state, 'invalid');
    assert.equal((await getQuoteAccess(rawToken)).state, 'open');

    const quote = await loadCustomerQuote(rawToken);
    assert.ok(quote);
    assert.equal(quote.totalAmount.toString(), '1139.24');
    assert.equal(quote.jobCard?.inspections[0].items.length, 2, 'only attention/fail findings are shown');
    assert.equal('id' in quote, false, 'internal ids are not exposed');

    // Another customer's link opens their quotation, never this one.
    const other = await createOtherSentEstimate(a);
    const otherAccess = await getQuoteAccess(other.rawToken);
    assert.equal(otherAccess.state === 'open' && otherAccess.resourceId, other.estimateId);
    otherJob = other;
  });

  test('12. customer approves → workshop sees it', async () => {
    await decideQuoteAsCustomer(rawToken, 'APPROVED', 'Please go ahead');

    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId }, include: { approvals: { include: { items: true } }, items: true } });
    assert.equal(estimate.status, 'APPROVED');
    assert.equal(estimate.approvals.length, 1);
    // The customer decided online; no staff member is recorded as having approved it.
    assert.equal(estimate.approvals[0].approvalMethod, 'ONLINE');
    assert.equal(estimate.approvals[0].customerId, customerId);
    assert.equal(estimate.approvals[0].recordedByUserId, null);
    assert.ok(estimate.approvals[0].decidedAt instanceof Date);
    // The staff member who sent the quotation stays on the estimate.
    assert.equal(estimate.sentByUserId, a.owner.id);
    assert.equal(estimate.approvals[0].items.length, estimate.items.length);
    assert.equal(await jobStatus(jobCardId), 'APPROVED');

    await expectDomainError(decideQuoteAsCustomer(rawToken, 'REJECTED', null), /already been recorded/);

    const approvalAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: estimate.approvals[0].id } });
    assert.equal(approvalAudit.action, 'approval.approved');
    assert.equal(approvalAudit.actorUserId, null);
    assert.equal((approvalAudit.metadata as { decidedBy: string }).decidedBy, 'customer');
    assert.equal((approvalAudit.metadata as { sentByUserId: string }).sentByUserId, a.owner.id);

    const history = await prisma.jobStatusHistory.findMany({ where: { jobCardId }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    assert.deepEqual(
      history.map((h) => h.toStatus),
      ['ARRIVED', 'INSPECTION', 'DIAGNOSIS', 'ESTIMATE', 'WAITING_APPROVAL', 'APPROVED'],
    );
    // Every change before the decision was made by staff; the approval by the customer.
    assert.ok(history.slice(0, -1).every((h) => h.changedByUserId === a.owner.id && h.changedByCustomerId === null));
    assert.equal(history.at(-1)?.changedByCustomerId, customerId);
    assert.equal(history.at(-1)?.changedByUserId, null);
    assert.deepEqual(await auditActions(a.owner.organizationId, estimateId), ['estimate.created', 'estimate.sent']);

    const workspace = await getJobWorkspace(a.owner, jobCardId);
    assert.equal(getNextAction(workspace).title, 'Start the repair');
    const vehicle = await getVehicleDetail(a.owner, vehicleId);
    assert.equal(vehicle.jobCards[0].estimates[0].status, 'APPROVED');
  });

  test('13. rejection, revision and expired links', async () => {
    const { jobCardId: job2, estimateId: est2, rawToken: token2 } = otherJob;
    await recordCustomerDecision(a.owner, est2, { decision: 'REJECTED', method: 'PHONE', notes: 'Too expensive' });
    assert.equal(await jobStatus(job2), 'REJECTED');
    const rejection = await prisma.approval.findFirstOrThrow({ where: { estimateId: est2 } });
    assert.equal(rejection.approvalMethod, 'PHONE');
    assert.equal(rejection.recordedByUserId, a.owner.id, 'staff who took the call is recorded');
    assert.ok(rejection.customerId, 'the decision still belongs to the customer');
    const rejectedHistory = await prisma.jobStatusHistory.findFirstOrThrow({
      where: { jobCardId: job2, toStatus: 'REJECTED' },
    });
    assert.equal(rejectedHistory.changedByUserId, a.owner.id);
    let workspace = await getJobWorkspace(a.owner, job2);
    assert.equal(getNextAction(workspace).title, 'Customer rejected the estimate');

    const revision = await reviseEstimate(a.owner, est2);
    assert.equal(await jobStatus(job2), 'ESTIMATE', 'revising reopens the estimate stage');
    assert.equal(revision.version, 2);
    assert.equal(revision.previousVersionId, est2);
    assert.match(revision.estimateNumber, /^EST-\d{6}-R2$/);
    assert.equal(await prisma.estimateItem.count({ where: { estimateId: revision.id } }), 1);
    assert.equal((await getQuoteAccess(token2)).state, 'invalid', 'old link revoked');
    assert.equal((await prisma.estimate.findUniqueOrThrow({ where: { id: est2 } })).status, 'REJECTED', 'history kept');

    const resent = await sendEstimate(a.owner, revision.id);
    workspace = await getJobWorkspace(a.owner, job2);
    assert.equal(workspace.estimate?.id, revision.id);
    assert.equal(getNextAction(workspace).title, 'Waiting for customer approval');
    assert.equal(await jobStatus(job2), 'WAITING_APPROVAL');

    // Expired link: can't be viewed or used.
    await prisma.customerAccessToken.updateMany({
      where: { tokenHash: hashToken(resent.rawToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await getQuoteAccess(resent.rawToken)).state, 'expired');
    await expectDomainError(decideQuoteAsCustomer(resent.rawToken, 'APPROVED', null), /link has expired/);
  });

  test('13b. database enforces attribution rules', async () => {
    const approval = await prisma.approval.findFirstOrThrow({ where: { estimateId } });
    // An ONLINE decision can't carry a recording staff member…
    await assert.rejects(
      prisma.approval.update({ where: { id: approval.id }, data: { recordedByUserId: a.owner.id } }),
      /approvals_recorder_matches_method|check constraint/i,
    );
    // …and a history row can't have two actors, or none.
    await assert.rejects(
      prisma.jobStatusHistory.create({
        data: {
          organizationId: a.owner.organizationId,
          jobCardId,
          toStatus: 'ON_HOLD',
          changedByUserId: a.owner.id,
          changedByCustomerId: customerId,
        },
      }),
      /job_status_history_single_actor|check constraint/i,
    );
    await assert.rejects(
      prisma.jobStatusHistory.create({
        data: { organizationId: a.owner.organizationId, jobCardId, toStatus: 'ON_HOLD' },
      }),
      /job_status_history_single_actor|check constraint/i,
    );
  });

  test('14. permissions and tenant isolation', async () => {
    await assert.rejects(
      prisma.$transaction((tx) => createCustomer(tx, a.viewer, { name: 'Nope', phone: '0501234567' })),
      AuthError,
    );
    await assert.rejects(
      checkInVehicle(a.viewer, { mode: 'existing', vehicleId, visit: { complaint: 'x x x', mileage: '1' } }),
      AuthError,
    );
    await assert.rejects(reviseEstimate(a.viewer, estimateId), AuthError);
    await assert.rejects(assignPrimaryTechnician(a.viewer, jobCardId, a.technicianIds[0]), AuthError);
    // The viewer can look but not touch.
    await getJobWorkspace(a.viewer, jobCardId);

    // Another organization can't see or act on this job at all.
    await expectDomainError(getJobWorkspace(b.owner, jobCardId), /could not be found/);
    await expectDomainError(getVehicleDetail(b.owner, vehicleId), /could not be found/);
    await expectDomainError(reviseEstimate(b.owner, estimateId), /could not be found/);
    await expectDomainError(startInspection(b.owner, jobCardId, b.technicianIds[0]), /could not be found/);
  });
});

let otherJob: { jobCardId: string; estimateId: string; rawToken: string };

/** A second customer's job taken straight to "estimate sent", used for isolation and rejection tests. */
async function createOtherSentEstimate(org: TestOrg) {
  const checkIn = await checkInVehicle(org.owner, {
    mode: 'new',
    customer: { name: 'Second Customer', phone: '056 111 2233' },
    vehicle: { plateNumber: `S ${RUN.slice(-5)}`, make: 'Honda', model: 'Civic' },
    visit: { complaint: 'Service due', mileage: '30000' },
  });
  const inspection = await startInspection(org.owner, checkIn.jobCardId, org.technicianIds[0]);
  await saveInspection(org.owner, inspection.id, { items: [{ description: 'Engine oil', result: 'OK' }] }, { complete: true });
  await saveDiagnosis(org.owner, checkIn.jobCardId, {
    employeeId: org.technicianIds[0],
    findings: 'Routine service due',
    recommendedAction: 'Minor service',
  });
  const estimate = await createEstimate(org.owner, checkIn.jobCardId);
  await saveEstimateDraft(org.owner, estimate.id, {
    validUntil: localDateString(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)),
    items: [{ itemType: 'LABOUR', description: 'Minor service', quantity: '1', unitPrice: '350' }],
  });
  const { rawToken } = await sendEstimate(org.owner, estimate.id);
  return { jobCardId: checkIn.jobCardId, estimateId: estimate.id, rawToken };
}
