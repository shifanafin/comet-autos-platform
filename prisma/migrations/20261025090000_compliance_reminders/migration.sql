-- Reminders for tax and accounting deadlines, and VAT returns filed before
-- these books began.
--
--  * NotificationKind COMPLIANCE_REMINDER: a VAT return, corporate tax,
--    trade licence or monthly-routine deadline coming or passed, sent to the
--    people who keep the books (lib/compliance/reminders.ts).
--  * vat_filings.outside_books: a return for a period before the books
--    began, filed with the FTA before the app was used. Kept so the
--    calendar knows it was filed; never booked, because its VAT is part of
--    the opening balances. Every existing return stays false.

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'COMPLIANCE_REMINDER';

ALTER TABLE "vat_filings"
  ADD COLUMN "outside_books" BOOLEAN NOT NULL DEFAULT false;
