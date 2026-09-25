/**
 * Integration tests for the workshop's own settings: the details that head
 * every customer document, and the VAT configuration the rest of the system
 * reads. The rule that matters most is that changing the rate changes what is
 * offered next and never what has already been issued.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import {
  getOrganizationSettings,
  getWorkshopPreferences,
  setDetailedJobCards,
  setHiddenMenus,
  updateOrganizationSettings,
} from '@/lib/organization/settings';
import { isMenuShown } from '@/lib/nav';
import { resolveDefaultVatRate, getVatSettings } from '@/lib/tax';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import { createEstimate, saveEstimateDraft, sendEstimate } from '@/lib/workshop/estimates';
import { getQuotationDocument } from '@/lib/documents/build';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

/** The emphasised 'Total' row of a rendered document. */
const documentTotal = (doc: { totals: { label: string; amount: string; emphasis?: string }[] }) =>
  doc.totals.find((row) => row.emphasis === 'total')?.amount ??
  doc.totals[doc.totals.length - 1]?.amount;

let a: TestOrg;
let b: TestOrg;
let estimateId: string;

const valid = (over: Record<string, unknown> = {}) => ({
  name: 'Comet Autos Test',
  legalName: 'Comet Autos Workshop LLC',
  address: 'Al Qusais, Dubai',
  phone: '04 555 1234',
  email: 'Service@Comet.Test',
  taxNumber: '100200300400003',
  isVatRegistered: 'true',
  vatRate: '5',
  ...over,
});

before(async () => {
  a = await createTestOrg('SetA');
  b = await createTestOrg('SetB');

  // A quotation priced at 5%, to prove later rate changes leave it alone.
  const { jobCardId } = await checkInVehicle(a.owner, {
    mode: 'new',
    customer: { name: 'Settings Customer', phone: '050 606 7070', email: '' },
    vehicle: { plateNumber: `S${RUN.slice(-4)} 99`, make: 'Toyota', model: 'Yaris' },
    visit: { complaint: 'Service', mileage: '20000' },
  });
  const inspection = await startInspection(a.owner, jobCardId, a.technicianIds[0]);
  await saveInspection(
    a.owner,
    inspection.id,
    { items: [{ description: 'Oil', result: 'ATTENTION_NEEDED', notes: 'Due' }] },
    { complete: true },
  );
  await saveDiagnosis(a.owner, jobCardId, {
    findings: 'Service due',
    recommendedAction: 'Service',
    employeeId: a.technicianIds[0],
  });
  const estimate = await createEstimate(a.owner, jobCardId);
  await saveEstimateDraft(a.owner, estimate.id, {
    validUntil: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    items: [
      {
        itemType: 'LABOUR',
        description: 'Service',
        quantity: '1',
        unitPrice: '100.00',
        taxRate: '5',
      },
    ],
  });
  await sendEstimate(a.owner, estimate.id);
  estimateId = estimate.id;
});

after(async () => {
  await prisma.$disconnect();
});

describe('workshop settings', () => {
  test('the current settings are readable, with the rate to two decimals', async () => {
    const settings = await getOrganizationSettings(a.owner);
    assert.equal(settings.isVatRegistered, true);
    assert.equal(settings.vatRate, '5.00');
    assert.equal(settings.baseCurrency, 'AED');
  });

  test('details are saved, normalised, and audited', async () => {
    const saved = await updateOrganizationSettings(a.owner, valid());
    assert.equal(saved.name, 'Comet Autos Test');
    assert.equal(saved.email, 'service@comet.test', 'email is lower-cased');
    assert.equal(saved.taxNumber, '100200300400003');
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: a.organizationId, action: 'organization.settings_updated' },
      }),
      'the change is audited',
    );
  });

  test('a TRN typed with spaces is stored as digits', async () => {
    const saved = await updateOrganizationSettings(
      a.owner,
      valid({ taxNumber: '1002 0030 0400 003' }),
    );
    assert.equal(saved.taxNumber, '100200300400003');
  });

  test('bad input is refused, field by field', async () => {
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ name: 'x' })),
      /workshop name/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ email: 'not-an-email' })),
      /valid email/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ phone: 'call me' })),
      /valid phone/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ taxNumber: 'TRN-ABC' })),
      /TRN/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ vatRate: 'five' })),
      /rate like/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ vatRate: '250' })),
      /between 0 and 100/i,
    );
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ isVatRegistered: 'maybe' })),
      /whether the workshop charges VAT/i,
    );
  });

  test('a refused save changes nothing', async () => {
    const before = await getOrganizationSettings(a.owner);
    await expectDomainError(
      updateOrganizationSettings(a.owner, valid({ vatRate: '250' })),
      /between 0 and 100/i,
    );
    const after = await getOrganizationSettings(a.owner);
    assert.deepEqual(
      { name: after.name, vatRate: after.vatRate, taxNumber: after.taxNumber },
      { name: before.name, vatRate: before.vatRate, taxNumber: before.taxNumber },
    );
  });

  test('a new rate is what new lines default to', async () => {
    await updateOrganizationSettings(a.owner, valid({ vatRate: '7.5' }));
    assert.equal(await resolveDefaultVatRate(a.organizationId), '7.50');
    const settings = await getVatSettings(a.organizationId);
    assert.equal(settings.vatRate, '7.50');
  });

  test('changing the rate does not touch a quotation already issued', async () => {
    const document = await getQuotationDocument(a.owner, estimateId);
    const line = document.sections.flatMap((section) => section.lines)[0];
    assert.equal(line.taxRate, '5', 'it keeps the rate it was priced at');
    assert.equal(documentTotal(document), '105', '100.00 plus the 5% it was quoted at');
  });

  test('turning VAT off makes new lines zero but keeps the configured rate', async () => {
    await updateOrganizationSettings(a.owner, valid({ isVatRegistered: 'false', vatRate: '7.5' }));
    assert.equal(await resolveDefaultVatRate(a.organizationId), '0.00');
    const settings = await getVatSettings(a.organizationId);
    assert.equal(settings.isVatRegistered, false);
    assert.equal(settings.vatRate, '7.50', 'the rate is remembered for when they re-register');

    // And the issued quotation is still what the customer agreed to.
    const document = await getQuotationDocument(a.owner, estimateId);
    assert.equal(documentTotal(document), '105');

    await updateOrganizationSettings(a.owner, valid());
    assert.equal(await resolveDefaultVatRate(a.organizationId), '5.00');
  });

  test('the workshop name and TRN reach the customer document', async () => {
    await updateOrganizationSettings(
      a.owner,
      valid({ name: 'Comet Autos Al Qusais', taxNumber: '100999888777666' }),
    );
    const document = await getQuotationDocument(a.owner, estimateId);
    assert.equal(document.seller.name, 'Comet Autos Al Qusais');
    assert.equal(document.seller.taxNumber, '100999888777666');
  });

  test('reading needs accounting.view and saving needs accounting.edit', async () => {
    await assert.rejects(
      getOrganizationSettings(a.viewer),
      (error: unknown) => error instanceof AuthError,
    );
    await assert.rejects(
      updateOrganizationSettings(a.viewer, valid()),
      (error: unknown) => error instanceof AuthError,
    );
    // Seeing the settings does not imply being able to change them.
    const readOnly = { ...a.owner, orgWidePermissions: new Set(['accounting.view']) };
    assert.ok(await getOrganizationSettings(readOnly));
    await assert.rejects(
      updateOrganizationSettings(readOnly, valid()),
      (error: unknown) => error instanceof AuthError,
    );
  });

  test('one workshop cannot change another', async () => {
    await updateOrganizationSettings(b.owner, valid({ name: 'Other Workshop', vatRate: '0' }));
    const theirs = await getOrganizationSettings(b.owner);
    const ours = await getOrganizationSettings(a.owner);
    assert.equal(theirs.name, 'Other Workshop');
    assert.equal(theirs.vatRate, '0.00');
    assert.equal(ours.name, 'Comet Autos Al Qusais', 'unchanged by the other workshop');
    assert.equal(await resolveDefaultVatRate(a.organizationId), '5.00');
  });

  test('the same submission twice saves once', async () => {
    const input = valid({ name: 'Double Save', requestKey: `settings-duplicate-${RUN}` });
    const results = await Promise.allSettled([
      updateOrganizationSettings(a.owner, input),
      updateOrganizationSettings(a.owner, input),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const audits = await prisma.auditLog.count({
      where: {
        entityId: a.organizationId,
        action: 'organization.settings_updated',
        afterData: { path: ['name'], equals: 'Double Save' },
      },
    });
    assert.equal(audits, 1, 'only one change is recorded');
  });
});

describe('job card style and menus', () => {
  test('a new workshop starts on the minimal job card with every menu shown', async () => {
    const preferences = await getWorkshopPreferences(b.organizationId);
    assert.equal(preferences.detailedJobCards, false);
    assert.deepEqual(preferences.hiddenMenus, []);
    // The standard job card's own screens stay out of the way meanwhile.
    assert.equal(isMenuShown('/inspections', preferences), false);
    assert.equal(isMenuShown('/approvals', preferences), false);
    assert.equal(isMenuShown('/inventory/parts', preferences), true);
  });

  test('switching to the standard job card is saved, audited, and brings its menus back', async () => {
    await setDetailedJobCards(a.owner, true);
    const preferences = await getWorkshopPreferences(a.organizationId);
    assert.equal(preferences.detailedJobCards, true);
    assert.equal(isMenuShown('/inspections', preferences), true);
    assert.equal(
      await prisma.auditLog.count({
        where: { entityId: a.organizationId, action: 'organization.job_card_mode_changed' },
      }),
      1,
    );
    // Choosing what is already chosen records nothing.
    await setDetailedJobCards(a.owner, true);
    assert.equal(
      await prisma.auditLog.count({
        where: { entityId: a.organizationId, action: 'organization.job_card_mode_changed' },
      }),
      1,
    );
    await setDetailedJobCards(a.owner, false);
    assert.equal((await getWorkshopPreferences(a.organizationId)).detailedJobCards, false);
  });

  test('menus can be hidden, but never the ones the app needs, and never unknown ones', async () => {
    await setHiddenMenus(a.owner, [
      '/inventory/parts',
      '/finance/payables',
      '/settings',
      '/job-cards',
      '/',
      '/not-a-menu',
      '/inventory/parts',
    ]);
    const preferences = await getWorkshopPreferences(a.organizationId);
    assert.deepEqual(preferences.hiddenMenus, ['/finance/payables', '/inventory/parts']);
    assert.equal(isMenuShown('/inventory/parts', preferences), false);
    assert.equal(isMenuShown('/settings', preferences), true);
    assert.equal(isMenuShown('/job-cards', preferences), true);

    await setHiddenMenus(a.owner, []);
    assert.deepEqual((await getWorkshopPreferences(a.organizationId)).hiddenMenus, []);
  });

  test('changing either needs accounting.edit, and stays inside the workshop', async () => {
    const readOnly = { ...a.owner, orgWidePermissions: new Set(['accounting.view']) };
    await assert.rejects(
      setDetailedJobCards(readOnly, true),
      (error: unknown) => error instanceof AuthError,
    );
    await assert.rejects(
      setHiddenMenus(a.viewer, ['/customers']),
      (error: unknown) => error instanceof AuthError,
    );
    await setHiddenMenus(b.owner, ['/customers']);
    assert.deepEqual((await getWorkshopPreferences(a.organizationId)).hiddenMenus, []);
  });
});
