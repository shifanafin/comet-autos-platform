-- When and why an invoice was voided. A void invoice keeps its number
-- (numbers are never reused) and stays on record, marked VOID.
--
-- Purely additive: two nullable columns. No existing row changes meaning.

ALTER TABLE "invoices" ADD COLUMN "voided_at" TIMESTAMPTZ,
ADD COLUMN "void_reason" TEXT;
