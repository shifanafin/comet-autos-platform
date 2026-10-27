-- A job card can be shared with its customer by a secure link, as a
-- quotation or an invoice is: a third kind of customer link.
--
-- Additive only: a new enum value. No existing row changes.

ALTER TYPE "CustomerAccessResourceType" ADD VALUE IF NOT EXISTS 'JOB_CARD';
