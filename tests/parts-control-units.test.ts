/**
 * Controlled parts and stock — the pure rules: "did you mean…?" between a
 * part typed and the catalogue, a supplier's tax invoice compared with the
 * purchase recorded, where a delivery's input VAT is booked, and when an
 * invoice's Parts line must name a part. No database.
 */
import './unit-env';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LIKELY_SAME, SIMILAR, partSimilarity, similarParts, squeeze } from '@/lib/inventory/part-match';
import { compareBill } from '@/lib/inventory/bills';
import { receiptVatAccount } from '@/lib/accounting/postings';
import { unlinkedAllowed } from '@/lib/billing/part-lines';

const part = (name: string, sku = 'P-0001', id = name) => ({ id, name, sku });

describe('did you mean…?', () => {
  test('spelling, plurals, spaces and dashes are the same part', () => {
    for (const [typed, existing] of [
      ['Brake pad', 'Brake pads'],
      ['brake-pads', 'Brake Pads'],
      ['Spark plug', 'Sparkplug'],
      ['Oil filter', 'Oil filter Toyota'],
    ]) {
      assert.ok(
        partSimilarity({ name: typed }, part(existing)) >= LIKELY_SAME,
        `${typed} ~ ${existing}`,
      );
    }
  });

  test('a typo is asked about ("did you mean"), not refused', () => {
    const score = partSimilarity({ name: 'Alternater' }, part('Alternator'));
    assert.ok(score >= SIMILAR && score < LIKELY_SAME, String(score));
  });

  test('the same part number is the same part, whatever the name', () => {
    assert.equal(partSimilarity({ name: 'Coil', sku: '90919-02240' }, part('Ignition coil', '9091902240')), 1);
  });

  test('different parts are not offered', () => {
    for (const [typed, existing] of [
      ['Brake pad', 'Air filter'],
      ['Oil filter', 'Fuel pump'],
      ['Wiper blade', 'Wheel bearing'],
    ]) {
      assert.ok(partSimilarity({ name: typed }, part(existing)) < SIMILAR, `${typed} vs ${existing}`);
    }
  });

  test('close but different (front / rear) is asked about, not refused', () => {
    const score = partSimilarity({ name: 'Brake pad front' }, part('Brake pad rear'));
    assert.ok(score >= SIMILAR && score < LIKELY_SAME, String(score));
  });

  test('variants told apart by a short mark (LH / RH, H4 / H7) are never the same part', () => {
    for (const [typed, existing] of [
      ['Headlamp LH', 'Headlamp RH'],
      ['Bulb H4', 'Bulb H7'],
      ['Brake pad LH', 'Brake pad RH'],
    ]) {
      const score = partSimilarity({ name: typed }, part(existing));
      assert.ok(score < LIKELY_SAME, `${typed} vs ${existing}: ${score}`);
    }
    // The same mark still matches through a plural.
    assert.ok(partSimilarity({ name: 'Headlamps LH' }, part('Headlamp LH')) >= LIKELY_SAME);
  });

  test('the closest come first, and nothing for a name too short to compare', () => {
    const parts = [part('Air filter', 'P-1', 'a'), part('Brake pads', 'P-2', 'b'), part('Brake pad set', 'P-3', 'c')];
    assert.equal(similarParts({ name: 'Brake pads' }, parts)[0].part.id, 'b');
    assert.deepEqual(similarParts({ name: 'ab' }, parts), []);
    assert.equal(squeeze(' Brake-Pads (Front) '), 'brakepadsfront');
  });
});

describe('a tax invoice against the purchase', () => {
  const recorded = { subtotal: '100.00', taxAmount: '5.00', totalAmount: '105.00' };

  test('agrees to the fil, or within the shop’s 0.10 rounding', () => {
    assert.equal(compareBill(recorded, recorded).agrees, true);
    assert.equal(
      compareBill(recorded, { subtotal: '100.05', taxAmount: '5.00', totalAmount: '105.05' }).agrees,
      true,
    );
  });

  test('a different price or VAT is refused, with each difference', () => {
    const result = compareBill(recorded, { subtotal: '120.00', taxAmount: '6.00', totalAmount: '126.00' });
    assert.equal(result.agrees, false);
    assert.deepEqual(
      result.rows.map((row) => row.difference),
      [2000, 100, 2100],
    );
  });
});

describe('where a delivery’s input VAT is booked', () => {
  const at = (billStatus: string, billMatchedByUserId: string | null = null) => ({
    billStatus,
    billMatchedByUserId,
  });

  test('bill in hand: claimable; awaited: held apart; none: part of the cost', () => {
    assert.equal(receiptVatAccount(at('RECEIVED'), true), 'RECOVERABLE');
    assert.equal(receiptVatAccount(at('PENDING'), true), 'PENDING');
    assert.equal(receiptVatAccount(at('NO_TAX_INVOICE'), true), 'COST');
  });

  test('a bill matched after delivery leaves the delivery as booked (its own entry moves the VAT)', () => {
    assert.equal(receiptVatAccount(at('RECEIVED', 'user'), true), 'PENDING');
    assert.equal(receiptVatAccount(at('NO_TAX_INVOICE', 'user'), true), 'PENDING');
  });

  test('not VAT-registered: always part of the cost', () => {
    assert.equal(receiptVatAccount(at('RECEIVED'), false), 'COST');
    assert.equal(receiptVatAccount(at('PENDING'), false), 'COST');
  });
});

describe('Parts lines that may stay without a part when an invoice is changed', () => {
  const free = unlinkedAllowed([
    { id: 'old', partId: null, partUsageId: null },
    { id: 'fitted', partId: null, partUsageId: 'usage' },
    { id: 'linked', partId: 'part', partUsageId: null },
  ]);

  test('kept from before, or billed from the repair records — yes; new or once linked — no', () => {
    assert.equal(free({ sourceId: 'old' }), true);
    assert.equal(free({ sourceId: 'fitted' }), true);
    assert.equal(free({ sourceId: 'linked' }), false);
    assert.equal(free({}), false);
  });
});
