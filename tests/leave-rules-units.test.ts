/**
 * UAE leave, overtime and final-settlement rules (Labour Law 33/2021).
 * Pure rules — no database.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualLeaveAccruing,
  annualLeaveBalance,
  annualLeaveEarned,
  countedServiceDays,
  gratuityOnLeavingFils,
  leaveDeductionFils,
  leaveEncashmentFils,
  maxOtherDeductionFils,
  nightMinutes,
  overtimePayFils,
  splitLeave,
  splitWithin,
  suggestOvertime,
} from '@/lib/hr/leave-rules';

const at = (iso: string) => new Date(iso);

describe('service', () => {
  test('calendar days employed, less unpaid leave and absence', () => {
    assert.equal(countedServiceDays('2025-01-01', '2025-12-31'), 365);
    assert.equal(
      countedServiceDays('2025-01-01', '2025-12-31', 10),
      355,
      '10 unpaid days do not count',
    );
  });
});

describe('annual leave', () => {
  test('nothing usable in the first 6 months, but it is building up', () => {
    assert.equal(annualLeaveEarned(150), 0);
    assert.ok(annualLeaveAccruing(150) > 9.8 && annualLeaveAccruing(150) < 9.9);
  });

  test('2 days a month after 6 months; 30 days a year from 1 year', () => {
    assert.equal(annualLeaveEarned(183), 12.03);
    assert.equal(annualLeaveEarned(365), 30);
    assert.equal(annualLeaveEarned(730), 60);
  });

  test('absent days slow the accrual: a year with 10 unpaid days earns 29.18', () => {
    assert.equal(annualLeaveEarned(countedServiceDays('2025-01-01', '2026-12-31', 10)), 59.18);
  });

  test('balance: earned less taken; an opening balance carries in', () => {
    assert.deepEqual(annualLeaveBalance({ serviceDays: 365, takenDays: 12 }), {
      earned: 30,
      taken: 12,
      balance: 18,
      accruing: 0,
    });
    const carried = annualLeaveBalance({
      serviceDays: 730,
      opening: { days: 20, serviceDays: 365 },
      takenDays: 5,
    });
    assert.equal(carried.earned, 50, '20 carried in + 30 earned since');
    assert.equal(carried.balance, 45);
  });
});

describe('how a leave is paid', () => {
  const base = { serviceDays: 800, inProbation: false, annualBalance: 0, usedFull: 0, usedHalf: 0 };

  test('annual leave from the balance; days beyond it unpaid', () => {
    assert.deepEqual(splitLeave({ ...base, type: 'ANNUAL', days: 10, annualBalance: 7.5 }), {
      full: 7,
      half: 0,
      unpaid: 3,
      note: 'Only 7 day(s) of annual leave are left: the rest is unpaid.',
    });
    assert.equal(splitLeave({ ...base, type: 'ANNUAL', days: 5, annualBalance: 20 }).note, null);
  });

  test('annual leave in the first 6 months is unpaid', () => {
    const split = splitLeave({
      ...base,
      type: 'ANNUAL',
      days: 3,
      serviceDays: 100,
      annualBalance: 0,
    });
    assert.equal(split.unpaid, 3);
  });

  test('sick leave: 15 full, 30 half, then unpaid; unpaid in probation', () => {
    assert.deepEqual(
      { ...splitLeave({ ...base, type: 'SICK', days: 20, usedFull: 10 }), note: null },
      { full: 5, half: 15, unpaid: 0, note: null },
    );
    assert.equal(
      splitLeave({ ...base, type: 'SICK', days: 50, usedFull: 15, usedHalf: 30 }).unpaid,
      50,
    );
    assert.equal(splitLeave({ ...base, type: 'SICK', days: 2, inProbation: true }).unpaid, 2);
  });

  test('maternity 45 full + 15 half; study only after 2 years', () => {
    const maternity = splitLeave({ ...base, type: 'MATERNITY', days: 60 });
    assert.deepEqual([maternity.full, maternity.half, maternity.unpaid], [45, 15, 0]);
    assert.equal(splitLeave({ ...base, type: 'STUDY', days: 4, serviceDays: 400 }).unpaid, 4);
    assert.equal(splitLeave({ ...base, type: 'STUDY', days: 4 }).full, 4);
  });

  test('unpaid is unpaid; other leave is paid', () => {
    assert.equal(splitLeave({ ...base, type: 'UNPAID', days: 3 }).unpaid, 3);
    assert.equal(splitLeave({ ...base, type: 'OTHER', days: 3 }).full, 3);
  });

  test('a leave across two months: its days fall in order, full first', () => {
    // 10 days from 28 Sep: 4 full, 3 half, 3 unpaid → September has days 28–30.
    const split = { full: 4, half: 3, unpaid: 3 };
    assert.deepEqual(splitWithin('2026-09-28', split, '2026-09-01', '2026-09-30'), {
      full: 3,
      half: 0,
      unpaid: 0,
    });
    assert.deepEqual(splitWithin('2026-09-28', split, '2026-10-01', '2026-10-31'), {
      full: 1,
      half: 3,
      unpaid: 3,
    });
  });
});

describe('pay', () => {
  test('a day is a thirtieth of the month: 2 unpaid days on 3,000 = 200', () => {
    assert.equal(leaveDeductionFils(3_000_00, 2, 0), 200_00);
    assert.equal(leaveDeductionFils(3_000_00, 0, 2), 100_00, 'a half-pay day costs half a day');
  });

  test('overtime: +25% on a working day, +50% at night or on the rest day', () => {
    // 3,000 basic, 8 h day → 12.50 an hour.
    assert.equal(overtimePayFils(2, 3_000_00, 8, 'NORMAL'), 31_25);
    assert.equal(overtimePayFils(2, 3_000_00, 8, 'NIGHT'), 37_50);
  });

  test('a hand deduction is at most half the wage', () => {
    assert.equal(maxOtherDeductionFils(2_500_00), 1_250_00);
  });
});

describe('overtime from check-in and check-out (UAE time)', () => {
  test('beyond 8 hours on a working day; the night part at the night rate', () => {
    // 08:00–19:00 UAE = 04:00–15:00 UTC: 11 h worked, 3 h overtime, none at night.
    assert.deepEqual(
      suggestOvertime({
        clockIn: at('2026-10-05T04:00:00Z'),
        clockOut: at('2026-10-05T15:00:00Z'),
        normalHoursPerDay: 8,
        restDay: false,
        holiday: false,
      }),
      [{ kind: 'NORMAL', hours: 3 }],
    );
    // 14:00–23:30 UAE: 9.5 h worked, 1.5 h overtime — all after 22:00.
    assert.deepEqual(
      suggestOvertime({
        clockIn: at('2026-10-05T10:00:00Z'),
        clockOut: at('2026-10-05T19:30:00Z'),
        normalHoursPerDay: 8,
        restDay: false,
        holiday: false,
      }),
      [{ kind: 'NIGHT', hours: 1.5 }],
    );
    // 22:00–00:00 UAE = 18:00–20:00 UTC: two night hours.
    assert.equal(nightMinutes(at('2026-10-05T18:00:00Z'), at('2026-10-05T20:00:00Z')), 120);
  });

  test('every hour on the rest day or a holiday; under 15 minutes is nothing', () => {
    assert.deepEqual(
      suggestOvertime({
        clockIn: at('2026-10-09T05:00:00Z'),
        clockOut: at('2026-10-09T09:00:00Z'),
        normalHoursPerDay: 8,
        restDay: true,
        holiday: false,
      }),
      [{ kind: 'REST_DAY', hours: 4 }],
    );
    assert.deepEqual(
      suggestOvertime({
        clockIn: at('2026-10-05T04:00:00Z'),
        clockOut: at('2026-10-05T12:10:00Z'),
        normalHoursPerDay: 8,
        restDay: false,
        holiday: false,
      }),
      [],
    );
  });
});

describe('leaving', () => {
  test('no gratuity under a year; 21 days a year to 5, 30 after', () => {
    assert.equal(gratuityOnLeavingFils(364, 3_000_00), 0);
    assert.equal(gratuityOnLeavingFils(365, 3_000_00), 2_100_00);
    assert.equal(
      gratuityOnLeavingFils(365 * 6, 3_000_00),
      Math.round((3_000_00 * (105 + 30)) / 30),
    );
  });

  test('unused leave paid at basic ÷ 30 a day', () => {
    assert.equal(leaveEncashmentFils(10, 3_000_00), 1_000_00);
    assert.equal(leaveEncashmentFils(-2, 3_000_00), 0);
  });
});
