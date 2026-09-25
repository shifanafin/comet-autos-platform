/**
 * Guessing limits and redirects: staff sign-in, where a sign-in may send
 * the browser afterwards, and what a customer link shows.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/password';
import { authenticate, INVALID_CREDENTIALS_MESSAGE, safeReturnPath } from '@/lib/auth/sign-in';
import { throttleKey } from '@/lib/auth/throttle';
import { getCustomerAccess } from '@/lib/customer-access/access';
import { quotePreview } from '@/lib/customer-access/preview';
import { createQuotation, saveEstimateDraft, sendEstimate } from '@/lib/workshop/estimates';
import { localDateString } from '@/lib/format';
import { createTestOrg, RUN, type TestOrg } from './support';

let org: TestOrg;
const email = `security-${RUN.toLowerCase()}@test.local`;
const PASSWORD = 'Garage2026!';
// A fresh address per run, so earlier runs' counts never carry over.
const address = `203.0.113.${Number.parseInt(RUN.slice(-2), 36) % 250}-${RUN}`;

before(async () => {
  org = await createTestOrg('Security');
  await prisma.user.update({
    where: { id: org.owner.id },
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  });
});

after(async () => {
  await prisma.authThrottle.deleteMany({
    where: { key: { in: [throttleKey('login', email), throttleKey('login-address', address)] } },
  });
  await prisma.$disconnect();
});

describe('staff sign-in', () => {
  test('the right password signs in, whichever way the email is typed', async () => {
    const result = await authenticate(`  ${email.toUpperCase()} `, PASSWORD, address);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.user.id, org.owner.id);
  });

  test('a wrong account and a wrong password get the same answer', async () => {
    const noAccount = await authenticate(`nobody-${RUN}@test.local`, PASSWORD, 'unknown');
    const wrongPassword = await authenticate(email, 'not-it', 'unknown');
    assert.deepEqual(noAccount, { ok: false, error: INVALID_CREDENTIALS_MESSAGE });
    assert.deepEqual(wrongPassword, { ok: false, error: INVALID_CREDENTIALS_MESSAGE });
    // The success in between would have cleared it; start this account clean.
    await prisma.authThrottle.deleteMany({ where: { key: throttleKey('login', email) } });
  });

  test('five wrong passwords lock the account — even the right password waits', async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await authenticate(email, `wrong-${attempt}`, address);
      assert.deepEqual(result, { ok: false, error: INVALID_CREDENTIALS_MESSAGE }, `attempt ${attempt}`);
    }
    const fifth = await authenticate(email, 'wrong-5', address);
    assert.equal(fifth.ok, false);
    assert.match(!fifth.ok ? fifth.error : '', /Too many attempts.*15 minutes/);

    const rightButLocked = await authenticate(email, PASSWORD, address);
    assert.equal(rightButLocked.ok, false, 'no password is checked while locked');
    assert.match(!rightButLocked.ok ? rightButLocked.error : '', /Too many attempts/);
  });

  test('the lock lifts when its time is up, and a success clears the count', async () => {
    await prisma.authThrottle.update({
      where: { key: throttleKey('login', email) },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    const result = await authenticate(email, PASSWORD, address);
    assert.equal(result.ok, true);
    assert.equal(
      await prisma.authThrottle.count({ where: { key: throttleKey('login', email) } }),
      0,
    );
  });

  test('nothing identifying is stored — only hashes', async () => {
    await authenticate(email, 'wrong-again', address);
    const rows = await prisma.authThrottle.findMany({
      where: { key: { in: [throttleKey('login', email), throttleKey('login-address', address)] } },
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(!row.key.includes(email) && !row.key.includes(address), row.key);
      assert.match(row.key, /^[a-z-]+:[0-9a-f]{64}$/);
    }
  });
});

describe('return address after sign-in', () => {
  test('pages on this site are kept', () => {
    assert.equal(safeReturnPath('/job-cards?status=REPAIR'), '/job-cards?status=REPAIR');
    assert.equal(safeReturnPath('/finance/invoices/abc'), '/finance/invoices/abc');
  });

  test('other sites are refused however they are spelled', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      '/\n/evil.example',
      'javascript:alert(1)',
      '/login',
      '/login?next=/x',
      null,
      42,
    ]) {
      const result = safeReturnPath(bad);
      assert.equal(result, '/', `${String(bad)} → ${result}`);
    }
  });
});

describe('customer link', () => {
  test('opens with one tap; its WhatsApp preview names the document and amount, nothing internal', async () => {
    const customer = await prisma.customer.create({
      data: { organizationId: org.organizationId, name: 'Link Customer', phone: '050 777 4411' },
    });
    const quote = await createQuotation(org.owner, { customerId: customer.id });
    await saveEstimateDraft(org.owner, quote.id, {
      validUntil: localDateString(new Date(Date.now() + 7 * 86400000)),
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '100' }],
    });
    const { rawToken } = await sendEstimate(org.owner, quote.id);

    assert.equal((await getCustomerAccess(rawToken, 'ESTIMATE')).state, 'open');
    assert.equal((await getCustomerAccess(rawToken, 'INVOICE')).state, 'invalid');

    const preview = await quotePreview(rawToken);
    assert.match(preview.title, /^Quotation EST-/);
    assert.equal(preview.button, 'View & approve');
    assert.match(preview.amount ?? '', /^AED /);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(preview)), 'no internal ids');

    // A dead link previews as a plain "open" card, with no document details.
    const dead = await quotePreview('x'.repeat(43));
    assert.equal(dead.amount, null);
    assert.equal(dead.button, 'Open');
  });
});
