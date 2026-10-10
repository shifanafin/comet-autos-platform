-- Months before these books began, as totals.
--
-- The books start on the opening balance date, but the first tax year (and
-- the VAT quarters) began earlier. Each row is one month's totals — sales
-- and their VAT, parts bought, other costs, salaries — so the year's profit
-- and loss and those VAT returns are complete. It is booked as a summary
-- entry against "Opening balance equity", never against the bank: the
-- opening balances already hold what those months left behind.

ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'PRIOR_PERIOD';

CREATE TABLE "prior_period_summaries" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "period_from" DATE NOT NULL,
  "period_to" DATE NOT NULL,
  "sales" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sales_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "parts_bought" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "costs_with_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "purchases_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "costs_without_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "salaries" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "note" TEXT,
  "recorded_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "prior_period_summaries_pkey" PRIMARY KEY ("id"),
  -- One month at most, inside one calendar month, so each falls in one VAT period.
  CONSTRAINT "prior_period_summaries_one_month" CHECK (
    "period_to" >= "period_from"
    AND date_trunc('month', "period_from") = date_trunc('month', "period_to")
  ),
  CONSTRAINT "prior_period_summaries_amounts_not_negative" CHECK (
    "sales" >= 0 AND "sales_vat" >= 0 AND "parts_bought" >= 0 AND "costs_with_vat" >= 0
    AND "purchases_vat" >= 0 AND "costs_without_vat" >= 0 AND "salaries" >= 0
  )
);

CREATE UNIQUE INDEX "prior_period_summaries_organization_id_id_key" ON "prior_period_summaries"("organization_id", "id");
CREATE UNIQUE INDEX "prior_period_summaries_organization_id_period_from_key" ON "prior_period_summaries"("organization_id", "period_from");
CREATE INDEX "prior_period_summaries_organization_id_period_to_idx" ON "prior_period_summaries"("organization_id", "period_to");

ALTER TABLE "prior_period_summaries"
  ADD CONSTRAINT "prior_period_summaries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "prior_period_summaries_organization_id_recorded_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "recorded_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
