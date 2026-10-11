/**
 * Integration tests for quotation versions as options.
 *
 * A new version either replaces the one before (a correction: its link
 * stops working) or leaves it open as an option. Any open version may be
 * approved — by the customer on its own link, or recorded by staff — and
 * approving one makes it the version that counts and closes the others.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { checkInVehicle } from '@/lib/workshop/check-in';
import {
  createEstimate,
  recordCustomerDecision,
  reviseEstimate,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { decideQuoteAsCustomer, getQuoteAccess } from '@/lib/customer-access/quote';
import { getQuotation } from '@/lib/workshop/quotations';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, jobStatus, RUN, type TestOrg } from './support';

const validUntil = () => localDateString(new Date(Date.now() + 7 * 86400000));

let org: TestOrg;
let plate = 0;

/** A job card at the quotation step, its version 1 drafted with one line. */
async function quotedJob(price: string) {
  plate += 1;
  const customer = await prisma.customer.create({
    data: {
      organizationId: org.organizationId,
      name: `Option Customer ${plate} ${RUN}`,
      phone: `050 ${String(plate).padStart(3, '0')} 7711`,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.organizationId,
      customerId: customer.id,
      plateNumber: `O${plate} ${RUN.slice(-4)}`,
      make: 'Nissan',
      model: 'Patrol',
    },
  });
  const { jobCardId } = await checkInVehicle(org.owner, {
    mode: 'existing',
    vehicleId: vehicle.id,
    visit: { complaint: 'Brakes squeal' },
  });
  const estimate = await createEstimate(org.owner, jobCardId);
  await fill(estimate.id, price);
  return { jobCardId, v1: estimate.id };
}

async function fill(estimateId: string, price: string) {
  await saveEstimateDraft(org.owner, estimateId, {
    validUntil: validUntil(),
    items: [
      {
        itemType: 'LABOUR',
        description: 'Brake pads and service',
        quantity: '1',
        unitPrice: price,
      },
    ],
  });
}

const row = (id: string) =>
  prisma.estimate.findUniqueOrThrow({
    where: { id },
    select: { status: true, isCurrent: true, replacedAt: true },
  });

before(async () => {
  org = await createTestOrg('Options');
});

after(async () => {
  await prisma.$disconnect();
});

describe('a version kept open as an option', () => {
  test('both links work, and the customer may approve the older one', async () => {
    const { jobCardId, v1 } = await quotedJob('400');
    const { rawToken: link1 } = await sendEstimate(org.owner, v1);

    const v2 = await reviseEstimate(org.owner, v1, true);
    assert.equal((await getQuoteAccess(link1)).state, 'open', 'version 1 stays open');
    await fill(v2.id, '650');
    const { rawToken: link2 } = await sendEstimate(org.owner, v2.id);
    assert.equal((await getQuoteAccess(link1)).state, 'open', 'still open once version 2 is sent');
    assert.equal((await getQuoteAccess(link2)).state, 'open');

    const screen = await getQuotation(org.owner, v1);
    assert.equal(screen.isOpenOption, true);

    await decideQuoteAsCustomer(link1, 'APPROVED', 'The cheaper one, please');

    assert.deepEqual(await row(v1), { status: 'APPROVED', isCurrent: true, replacedAt: null });
    const second = await row(v2.id);
    assert.equal(second.isCurrent, false, 'version 2 no longer counts');
    assert.ok(second.replacedAt, 'version 2 closed as not chosen');
    assert.equal((await getQuoteAccess(link2)).state, 'invalid', 'its link is withdrawn');
    assert.equal(await jobStatus(jobCardId), 'APPROVED');
    assert.equal((await getQuotation(org.owner, v1)).isLatest, true);
  });

  test('staff may record the older option while the next version is still a draft', async () => {
    const { jobCardId, v1 } = await quotedJob('300');
    await sendEstimate(org.owner, v1);
    const v2 = await reviseEstimate(org.owner, v1, true);
    assert.equal(await jobStatus(jobCardId), 'ESTIMATE', 'drafting version 2');

    await recordCustomerDecision(org.owner, v1, { decision: 'APPROVED', method: 'PHONE' });

    assert.equal((await row(v1)).status, 'APPROVED');
    assert.equal(await jobStatus(jobCardId), 'APPROVED');
    assert.equal(
      await prisma.estimate.count({ where: { id: v2.id } }),
      0,
      'the unsent draft is removed',
    );
  });

  test('rejecting one option leaves the job waiting while another is open', async () => {
    const { jobCardId, v1 } = await quotedJob('500');
    const { rawToken: link1 } = await sendEstimate(org.owner, v1);
    const v2 = await reviseEstimate(org.owner, v1, true);
    await fill(v2.id, '700');
    const { rawToken: link2 } = await sendEstimate(org.owner, v2.id);

    await decideQuoteAsCustomer(link2, 'REJECTED', 'Too dear');
    assert.equal(await jobStatus(jobCardId), 'WAITING_APPROVAL', 'version 1 is still open');

    await decideQuoteAsCustomer(link1, 'REJECTED', 'Not now');
    assert.equal(await jobStatus(jobCardId), 'REJECTED', 'nothing left open');
  });
});

describe('a version replaced by a correction', () => {
  test('its link stops working and it can no longer be approved', async () => {
    const { v1 } = await quotedJob('250');
    const { rawToken: link1 } = await sendEstimate(org.owner, v1);
    await reviseEstimate(org.owner, v1);
    assert.equal((await getQuoteAccess(link1)).state, 'invalid');
    assert.ok((await row(v1)).replacedAt);
    await expectDomainError(
      recordCustomerDecision(org.owner, v1, { decision: 'APPROVED', method: 'PHONE' }),
      /replaced by a newer version/,
    );
  });

  test('only a version still waiting can be kept open', async () => {
    const { v1 } = await quotedJob('150');
    await sendEstimate(org.owner, v1);
    await recordCustomerDecision(org.owner, v1, { decision: 'REJECTED', method: 'PHONE' });
    await expectDomainError(reviseEstimate(org.owner, v1, true), /still waiting/);
  });
});
