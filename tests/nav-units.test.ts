/**
 * Unit tests for which menu item is current: the most specific match, a
 * tab link only on its own tab.
 *
 *   npm run test:unit
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { activeNavHref, NAV_GROUPS } from '@/lib/nav';

const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
const params = (query = '') => new URLSearchParams(query);

describe('the current menu item', () => {
  test('a page under a section lights its own item, not the section overview', () => {
    assert.equal(activeNavHref('/finance/expenses', params(), hrefs), '/finance/expenses');
    assert.equal(
      activeNavHref('/finance/accounting/opening-balances', params(), hrefs),
      '/finance/accounting/opening-balances',
    );
    assert.equal(activeNavHref('/finance', params(), hrefs), '/finance');
  });

  test('a record page lights its list', () => {
    assert.equal(activeNavHref('/finance/invoices/abc', params(), hrefs), '/finance/invoices');
  });

  test('an accounting tab lights only its own item', () => {
    assert.equal(
      activeNavHref('/finance/accounting', params('view=trial&asOf=2026-01-31'), hrefs),
      '/finance/accounting?view=trial',
    );
    assert.equal(
      activeNavHref('/finance/accounting', params('view=cash&period=month'), hrefs),
      '/finance/accounting?view=cash',
    );
  });

  test('a prefix of a word is not a match', () => {
    assert.equal(activeNavHref('/financeX', params(), hrefs), null);
  });

  test('the dashboard only on its own page', () => {
    assert.equal(activeNavHref('/', params(), hrefs), '/');
    assert.notEqual(activeNavHref('/customers', params(), hrefs), '/');
  });
});

describe('the sidebar sections', () => {
  const sectionOf = (href: string) => {
    const group = NAV_GROUPS.find((candidate) =>
      candidate.items.some((item) => item.href === href),
    );
    return group?.parent ?? group?.label ?? null;
  };

  test('every page is listed once', () => {
    assert.equal(new Set(hrefs).size, hrefs.length);
  });

  test('every page the menu has always offered is still there', () => {
    for (const href of [
      '/',
      '/workshop',
      '/sales',
      '/inventory',
      '/hr',
      '/job-cards',
      '/appointments',
      '/inspections',
      '/approvals',
      '/quotations',
      '/finance/invoices',
      '/finance/payments',
      '/finance/credit-notes',
      '/customers',
      '/vehicles',
      '/inventory/parts',
      '/inventory/purchases',
      '/inventory/suppliers',
      '/inventory/movements',
      '/finance',
      '/finance/outstanding',
      '/finance/statements',
      '/finance/expenses',
      '/finance/payables',
      '/finance/owner-advances',
      '/finance/vat',
      '/reports',
      '/finance/bank-reconciliation',
      '/finance/fixed-assets',
      '/finance/accounting/opening-balances',
      '/finance/accounting/year-end',
      '/finance/accounting/tax-codes',
      '/finance/accounting/payment-modes',
      '/hr/employees',
      '/hr/attendance',
      '/hr/leave',
      '/hr/payroll',
      '/settings',
      '/settings/users',
      '/settings/audit',
      '/letterhead',
    ]) {
      assert.ok(hrefs.includes(href), `${href} is in the menu`);
    }
  });

  test('every menu item is shown by a permission — except the home page and the employee self-service page', () => {
    const open = NAV_GROUPS.flatMap((group) => group.items)
      .filter((item) => !item.permission)
      .map((item) => `${item.href}${item.forEmployees ? ' (employees)' : ''}`);
    assert.deepEqual(open, ['/', '/my-work (employees)']);
  });

  test('pages sit in the section of their module, one level deep', () => {
    assert.equal(sectionOf('/job-cards'), 'Workshop');
    assert.equal(sectionOf('/team'), 'Workshop');
    assert.equal(sectionOf('/my-work'), null);
    assert.equal(sectionOf('/finance/invoices'), 'Customers & Sales');
    assert.equal(sectionOf('/finance/outstanding'), 'Customers & Sales');
    assert.equal(sectionOf('/inventory/suppliers'), 'Suppliers & Bills');
    assert.equal(sectionOf('/finance/expenses'), 'Suppliers & Bills');
    assert.equal(sectionOf('/inventory/purchases'), 'Parts & Stock');
    assert.equal(sectionOf('/finance/money'), 'Cash & Bank');
    assert.equal(sectionOf('/finance/owner-advances'), 'Cash & Bank');
    assert.equal(sectionOf('/finance/vat'), 'VAT & Tax');
    assert.equal(sectionOf('/finance/calendar'), 'VAT & Tax');
    assert.equal(sectionOf('/finance/accounting?view=trial'), 'Reports');
    assert.equal(sectionOf('/finance/accounting?view=journal'), 'Accounting');
    assert.equal(sectionOf('/finance/accounting/prior-periods'), 'Accounting');
    assert.equal(sectionOf('/hr/payroll'), 'HR & Payroll');
    assert.equal(sectionOf('/finance/accounting/tax-codes'), 'Settings');
    assert.equal(sectionOf('/settings/users'), 'Settings');
    assert.ok(
      NAV_GROUPS.every((group) => !group.parent),
      'no section is folded inside another',
    );
    const labels = NAV_GROUPS.flatMap((group) => group.items).map((item) => item.label);
    assert.equal(new Set(labels).size, labels.length, 'no two items share a name');
  });
});
