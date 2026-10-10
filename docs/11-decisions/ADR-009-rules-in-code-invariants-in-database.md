# ADR-009: Business rules in TypeScript, invariants in the database

Status: Accepted
Date: 2026-10-10

## Context

The app keeps the workshop's books, VAT, payroll and leave under UAE law.
Those rules change (a new Cabinet decision, a company policy) and must be
easy to read, test and hand over to other developers. At the same time some
facts must never be broken, whoever writes to the database — a script, a
future service, a bug.

Stored procedures for the rules themselves were considered: they run close
to the data, but are hard to unit-test, to review in a pull request, to
debug, and to keep in step with the TypeScript types the screens use.

## Decision

- **Rules live in TypeScript, as pure functions** with unit tests:
  `src/lib/hr/leave-rules.ts` (leave, overtime, settlement),
  `src/lib/compliance/rules.ts` (VAT periods, financial year, corporate
  tax), `src/lib/accounting/prior-period-rules.ts`, the posting rules in
  `src/lib/accounting/postings.ts`. A database-reading layer feeds them
  (e.g. `src/lib/hr/leave-ledger.ts`); services orchestrate, check
  permissions and write audit logs.
- **The database enforces invariants** — things that must hold no matter
  who writes:
  - CHECK constraints (a leave's paid + half + unpaid days add up; amounts
    not negative; a settlement's net equals its parts; one VAT schedule);
  - triggers that refuse changing what was already relied on (journal
    entries and lines are permanent; booked documents can't be deleted;
    approved/paid payroll lines and approved settlements can't change);
  - composite foreign keys `(organization_id, id)` on every relation, so no
    row can point into another workshop;
  - row-level security on every table (no policies: the public data API
    reads nothing; the app connects as the owner).
- Migrations are additive, written by hand, and never edited once applied.

## Consequences

- A rule change is one function and its test; reviewers see it in a diff.
- Integrity holds even if application code is bypassed.
- Some logic appears twice by intent (e.g. a CHECK and the service's own
  validation, so users get a friendly message before the database refuses).
