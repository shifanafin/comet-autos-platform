# Payroll and leave (UAE)

How the app pays people, under Federal Decree-Law 33 of 2021 (the Labour Law)
and Cabinet Resolution 1 of 2022. Every figure comes from one place:
`src/lib/hr/leave-rules.ts` (pure functions, unit-tested in
`tests/leave-rules-units.test.ts`). Change a rule there, and its test, and
the whole app follows.

## The day's wage

**Monthly ÷ 30** (the MOHRE convention), for unpaid days, half-pay days,
overtime, unused-leave payout and gratuity. A month's pay for someone who
joined or left during it is pro-rated by calendar days employed.

## Service

Calendar days from the first day of work, **less unpaid leave and days
absent with no approved leave** (half a day for a half day). Those days earn
neither annual leave nor end-of-service gratuity (Art. 29, 51).
`src/lib/hr/leave-ledger.ts` works it out from the database.

## Annual leave (Art. 29)

| Service        | Entitlement                                           |
| -------------- | ----------------------------------------------------- |
| Under 6 months | None usable (it builds up and shows as "building up") |
| 6 to 12 months | 2 days for each month of service                      |
| From 1 year    | 30 days a year, earned day by day                     |

- **Balance** = earned − annual leave taken on full pay. A balance carried in
  for someone who joined before the books is entered on the employee
  (`leaveOpeningDays` on `leaveOpeningAsOf`); accrual counts from that date.
- **Taking annual leave**: days within the balance are paid; days beyond it
  are unpaid. In the first 6 months all annual leave is unpaid.
- **Unused leave on leaving** is paid at basic ÷ 30 a day.
- **Provision**: each payroll sets aside the unused balance at basic ÷ 30
  (Dr Annual leave expense / Cr Provision for annual leave, the change since
  the last run). Taking leave lowers it — the salary paid during leave is
  covered by the provision released.

## How each leave is paid

Decided when the leave is requested, and again when it is approved (the
balance may have changed). Stored on the leave as full-pay, half-pay and
unpaid days, in that order from the first day; the database checks they add
up to the days.

| Type                  | Pay                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Annual                | From the balance; beyond it unpaid; unpaid in the first 6 months                             |
| Sick (Art. 31)        | After probation, per 12 months: 15 days full, 30 half, then unpaid. During probation: unpaid |
| Maternity (Art. 30)   | 45 days full, 15 half                                                                        |
| Parental (Art. 32)    | 5 days full                                                                                  |
| Bereavement (Art. 32) | Up to 5 days full                                                                            |
| Study (Art. 32)       | 10 days a year full, after 2 years' service                                                  |
| Unpaid                | Unpaid, not service                                                                          |
| Other                 | Paid (the workshop agrees it)                                                                |

Probation is at most 6 months (Art. 9); empty means 6 months from joining.

## Absence

A day marked **absent** (or half day) in attendance with no approved leave
is deducted at a day's wage (half for a half day) and does not count as
service. To excuse it, record leave for that day — annual leave takes it
from the balance instead.

## Overtime (Art. 17-19, 28)

- Normal day: the employee's `normalHoursPerDay` (8 by law).
- When someone checks out, the app **suggests** the overtime the day shows:
  hours beyond the normal day, the part between 22:00 and 04:00 as night;
  every hour on the weekly rest day or a public holiday.
- A manager **approves** (hours editable), rejects, or enters overtime by
  hand (HR → Overtime). Only approved hours are paid.
- Pay: hours × (basic ÷ 30 ÷ normal hours) × **1.25** (working day) or
  **1.5** (night, rest day, public holiday). More than 2 hours a day beyond
  the normal day is flagged (allowed only in emergencies).
- The weekly rest day and public holidays are set on the Overtime screen.

## A month's payroll

`src/lib/hr/payroll.ts` `calculateLines`:

```
pay        = basic + allowances (pro-rated for joiners/leavers)
leave      = (unpaid days + absent days) × (basic + allowances) ÷ 30
           + half-pay days × (basic + allowances) ÷ 60
overtime   = Σ approved hours × hourly basic × rate
other      = a hand deduction (advance / penalty / other), ≤ 50% of pay (Art. 25)
net        = pay + overtime − leave − other
```

Also set aside, to the period end, on counted service: the end-of-service
gratuity and the unused annual leave.

- Runs by itself on the 1st for the month just ended (from the first full
  month of the books), waiting for a person to approve. Months run in order.
- A hand deduction survives a recalculation; the leave part is recalculated.
- An approved or paid payroll can't change — the database refuses it
  (`payroll_item_locked` trigger).

**Booked** (`src/lib/accounting/postings.ts`, PAYROLL):

|                                    | Dr                     | Cr                           |
| ---------------------------------- | ---------------------- | ---------------------------- |
| Wage cost (pay + overtime − leave) | Salaries & wages       |                              |
| Net pay                            |                        | Salaries payable             |
| Advance recovered                  |                        | Staff advances               |
| Penalty / other deduction          |                        | Other income                 |
| Gratuity set aside (±)             | End-of-service expense | Provision for end-of-service |
| Leave set aside (±)                | Annual leave expense   | Provision for annual leave   |

Paid: Dr Salaries payable / Cr Bank, through WPS (the SIF file:
`src/lib/hr/wps-file.ts`).

## Leaving: final settlement (Art. 51-53)

HR → employee → _Work out a final settlement_. Due within **14 days** of the
last working day (it shows on the tax & accounting calendar).

| Item            | Rule                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Gratuity        | 21 days' basic a year for the first 5 years, 30 after; ≤ 2 years' basic; **nothing under 1 year** of counted service |
| Unused leave    | Balance on the leaving date × basic ÷ 30                                                                             |
| Notice          | Pay in lieu (+), or notice the employee owes (−)                                                                     |
| Other additions | e.g. an air ticket in the contract                                                                                   |
| Recoveries      | Salary advances still owed                                                                                           |

The leaving month's payroll must be approved first (it pays the last days
and brings both provisions to the leaving date). The settlement then uses
what was set aside and books only the difference:

|                   | Dr                                                             | Cr               |
| ----------------- | -------------------------------------------------------------- | ---------------- |
| Gratuity          | Provision (held) + expense (difference; a release if negative) |                  |
| Leave             | Provision (held) + expense (difference)                        |                  |
| Notice, additions | Salaries & wages                                               |                  |
| Recoveries        |                                                                | Staff advances   |
| Net payable       |                                                                | Salaries payable |

Draft → approved (booked) → paid (booked). An approved settlement can be
cancelled (entry reversed) until it is paid; the database refuses changing
an approved settlement's figures (`final_settlement_locked`).

## Where things are

| What                         | File                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Rules (pure)                 | `src/lib/hr/leave-rules.ts`, `src/lib/hr/gratuity.ts`, `src/lib/hr/payroll-schedule.ts` |
| Facts from the database      | `src/lib/hr/leave-ledger.ts`                                                            |
| Leave                        | `src/lib/hr/leave.ts`                                                                   |
| Overtime, rest day, holidays | `src/lib/hr/overtime.ts`                                                                |
| Payroll                      | `src/lib/hr/payroll.ts`                                                                 |
| Final settlement             | `src/lib/hr/settlement.ts`                                                              |
| WPS file                     | `src/lib/hr/wps.ts`, `src/lib/hr/wps-file.ts`                                           |
| Bookings                     | `src/lib/accounting/postings.ts` (PAYROLL, FINAL_SETTLEMENT)                            |
| Database                     | `prisma/migrations/20261029090000_uae_payroll_leave`                                    |

## Points to confirm with a UAE labour adviser

- Whether overtime is calculated on basic wage only (as here) or total wage.
- Whether the "two years' wage" gratuity cap is on basic only (as here).
- Leave days counted as calendar days (as here) or working days under the
  contract.
- Whether the WPS "days on leave" field should carry all leave or unpaid
  leave only (the app sends all leave days).
