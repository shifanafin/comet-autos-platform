/**
 * Unit tests for an account month by month: each month opens on the last
 * one's close, a month with nothing in it still shows, and the first and
 * last months are cut to the period chosen.
 *
 *   npm run test:unit
 */
import './unit-env';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { monthByMonth } from '@/lib/accounting/months';

describe('month by month', () => {
  test('each month opens on the last close, empty months included', () => {
    const months = monthByMonth(
      78603,
      [
        { date: '2026-09-23', a: 45000, b: 0, delta: 45000 },
        { date: '2026-10-01', a: 200000, b: 0, delta: 200000 },
        { date: '2026-10-10', a: 0, b: 41600, delta: -41600 },
        { date: '2026-12-05', a: 10000, b: 0, delta: 10000 },
      ],
      '2026-09-16',
      '2026-12-31',
    );
    assert.deepEqual(
      months.map((m) => [m.month, m.opening, m.a, m.b, m.closing]),
      [
        ['2026-09', 78603, 45000, 0, 123603],
        ['2026-10', 123603, 200000, 41600, 282003],
        ['2026-11', 282003, 0, 0, 282003],
        ['2026-12', 282003, 10000, 0, 292003],
      ],
    );
    assert.equal(months[0].from, '2026-09-16', 'the first month starts with the period');
    assert.equal(months[1].to, '2026-10-31');
  });

  test('a balance that runs the other way (owed on a card)', () => {
    const [only] = monthByMonth(
      0,
      [{ date: '2026-10-02', a: 0, b: 5000, delta: 5000 }],
      '2026-10-01',
      '2026-10-21',
    );
    assert.equal(only.closing, 5000);
    assert.equal(only.to, '2026-10-21', 'the last month ends with the period');
  });

  test('a period the wrong way round has no months', () => {
    assert.deepEqual(monthByMonth(0, [], '2026-10-05', '2026-10-01'), []);
  });
});
