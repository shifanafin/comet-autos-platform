/**
 * Unit tests for telling two spellings of one vendor apart from two vendors,
 * as the duplicate-bill check does: the same fuel bill was once entered as
 * from "ENOC / EPPCO" and again as from "ENOC".
 *
 *   npm run test:unit
 */
import './unit-env';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sameVendor } from '@/lib/finance/vendor-names';

describe('vendor names', () => {
  test('one vendor, spelt two ways', () => {
    assert.equal(sameVendor('ENOC / EPPCO', 'ENOC'), true);
    assert.equal(sameVendor('Enoc', 'ENOC.'), true);
    assert.equal(sameVendor('Al Amani Trading L.L.C', 'al amani trading llc'), true);
  });

  test('two vendors', () => {
    assert.equal(sameVendor('ENOC', 'ADNOC Distribution'), false);
    assert.equal(sameVendor('Taimoor Auto Spare Parts', 'Al Amani Trading'), false);
    assert.equal(sameVendor('AB', 'ABC Motors'), false, 'too short to say');
    assert.equal(sameVendor('', 'ENOC'), false);
  });
});
