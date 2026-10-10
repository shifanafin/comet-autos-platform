/**
 * The tax & accounting calendar's date rules: VAT periods and their due
 * dates, the financial year a day falls in, and corporate tax. Pure rules —
 * no database.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  corporateTaxDue,
  corporateTaxEstimateFils,
  financialYearOf,
  lastEndedYear,
  periodEnd,
  smallBusinessReliefPossible,
  vatPeriods,
} from '@/lib/compliance/rules';
import { reminderStage, reminderTitle, weekOf } from '@/lib/compliance/reminder-rules';

describe('VAT periods', () => {
  test('a period of months ends the day before the same date', () => {
    assert.equal(periodEnd('2026-10-01', 3), '2026-12-31');
    assert.equal(periodEnd('2026-12-01', 3), '2027-02-28');
    assert.equal(periodEnd('2026-09-16', 1), '2026-10-15');
    assert.equal(periodEnd('2027-01-31', 1), '2027-02-28');
  });

  test('a short first period, then quarters back to back, each due 28 days after it ends', () => {
    const periods = vatPeriods(
      { firstStart: '2026-09-16', firstEnd: '2026-11-30', months: 3 },
      '2027-03-10',
    );
    assert.deepEqual(
      periods.map((p) => [p.from, p.to, p.due]),
      [
        ['2026-09-16', '2026-11-30', '2026-12-28'],
        ['2026-12-01', '2027-02-28', '2027-03-28'],
        ['2027-03-01', '2027-05-31', '2027-06-28'],
        ['2027-06-01', '2027-08-31', '2027-09-28'],
      ],
    );
  });

  test('monthly returns', () => {
    const periods = vatPeriods(
      { firstStart: '2026-10-01', firstEnd: '2026-10-31', months: 1 },
      '2026-11-05',
    );
    assert.deepEqual(
      periods.map((p) => p.to),
      ['2026-10-31', '2026-11-30', '2026-12-31'],
    );
  });
});

describe('financial year', () => {
  const books = { endMonth: 12, booksStart: '2026-09-16' };

  test('the first year runs from the books’ start to the year end', () => {
    assert.deepEqual(financialYearOf('2026-10-08', books), {
      start: '2026-09-16',
      end: '2026-12-31',
      first: true,
    });
    assert.deepEqual(financialYearOf('2027-05-01', books), {
      start: '2027-01-01',
      end: '2027-12-31',
      first: false,
    });
  });

  test('a long first year, then twelve months', () => {
    const rule = { ...books, firstYearEnd: '2027-12-31' };
    assert.equal(financialYearOf('2026-10-08', rule).end, '2027-12-31');
    assert.deepEqual(financialYearOf('2028-02-01', rule), {
      start: '2028-01-01',
      end: '2028-12-31',
      first: false,
    });
  });

  test('a year ending in March', () => {
    const rule = { endMonth: 3 };
    assert.equal(financialYearOf('2026-03-31', rule).end, '2026-03-31');
    assert.equal(financialYearOf('2026-04-01', rule).end, '2027-03-31');
    assert.equal(financialYearOf('2026-04-01', rule).start, '2026-04-01');
  });

  test('the last year that ended — none while the first is still running', () => {
    assert.equal(lastEndedYear('2026-10-08', books), null);
    assert.equal(lastEndedYear('2027-02-01', books)?.end, '2026-12-31');
    assert.equal(lastEndedYear('2026-12-31', books)?.end, '2026-12-31');
  });
});

describe('corporate tax', () => {
  test('due on the last day of the ninth month after the year ends', () => {
    assert.equal(corporateTaxDue('2026-12-31'), '2027-09-30');
    assert.equal(corporateTaxDue('2027-03-31'), '2027-12-31');
    assert.equal(corporateTaxDue('2027-06-30'), '2028-03-31');
  });

  test('0% up to AED 375,000, 9% above', () => {
    assert.equal(corporateTaxEstimateFils(-5_000_00), 0);
    assert.equal(corporateTaxEstimateFils(375_000_00), 0);
    assert.equal(corporateTaxEstimateFils(475_000_00), 9_000_00);
  });

  test('Small Business Relief: revenue up to AED 3 million, years ending by 31 Dec 2026', () => {
    assert.equal(smallBusinessReliefPossible('2026-12-31', 2_999_999_00), true);
    assert.equal(smallBusinessReliefPossible('2026-12-31', 3_000_001_00), false);
    assert.equal(smallBusinessReliefPossible('2027-12-31', 1_000_00), false);
  });
});

describe('reminders', () => {
  test('30, 14, 7, 3, 1 days before and on the day', () => {
    assert.equal(reminderStage('2026-10-10', '2026-11-28'), null, 'more than 30 days away');
    assert.equal(reminderStage('2026-10-29', '2026-11-28'), 'due-30');
    assert.equal(reminderStage('2026-11-14', '2026-11-28'), 'due-14');
    assert.equal(
      reminderStage('2026-11-20', '2026-11-28'),
      'due-14',
      'between stages: the last one reached',
    );
    assert.equal(reminderStage('2026-11-21', '2026-11-28'), 'due-7');
    assert.equal(reminderStage('2026-11-27', '2026-11-28'), 'due-1');
    assert.equal(reminderStage('2026-11-28', '2026-11-28'), 'due-0');
  });

  test('late: again every three days until done', () => {
    assert.equal(reminderStage('2026-11-29', '2026-11-28'), 'late-0');
    assert.equal(reminderStage('2026-12-01', '2026-11-28'), 'late-0');
    assert.equal(reminderStage('2026-12-02', '2026-11-28'), 'late-1');
    assert.equal(reminderStage('2026-12-05', '2026-11-28'), 'late-2');
  });

  test('headings say how long is left', () => {
    assert.equal(reminderTitle('VAT return', '2026-11-28', '2026-11-28'), 'Due today: VAT return');
    assert.equal(
      reminderTitle('VAT return', '2026-11-28', '2026-11-27'),
      'Due tomorrow: VAT return',
    );
    assert.equal(
      reminderTitle('VAT return', '2026-11-28', '2026-11-21'),
      'Due in 7 days: VAT return',
    );
    assert.equal(reminderTitle('VAT return', '2026-08-28', '2026-10-10'), 'Late: VAT return');
  });

  test('weekly reminders are keyed by the Monday', () => {
    assert.equal(weekOf('2026-10-10'), '2026-10-05');
    assert.equal(weekOf('2026-10-05'), '2026-10-05');
  });

  test('your VAT quarters: Feb–Apr, May–Jul, Aug–Oct, Nov–Jan', () => {
    const periods = vatPeriods(
      { firstStart: '2026-02-01', firstEnd: '2026-04-30', months: 3 },
      '2026-10-10',
    );
    assert.deepEqual(
      periods.map((p) => [p.from, p.to, p.due]),
      [
        ['2026-02-01', '2026-04-30', '2026-05-28'],
        ['2026-05-01', '2026-07-31', '2026-08-28'],
        ['2026-08-01', '2026-10-31', '2026-11-28'],
        ['2026-11-01', '2027-01-31', '2027-02-28'],
      ],
    );
  });
});
