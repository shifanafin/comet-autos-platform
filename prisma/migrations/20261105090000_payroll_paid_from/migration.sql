-- Payroll payment: the day the salaries were paid (the WPS transfer date) and
-- the cash or bank account they left, like a final settlement. Additive only:
-- runs already paid keep `paid_at` and the default bank.
ALTER TABLE "payrolls"
  ADD COLUMN "paid_on" DATE,
  ADD COLUMN "paid_from_account_id" UUID;

ALTER TABLE "payrolls"
  ADD CONSTRAINT "payrolls_organization_id_paid_from_account_id_fkey" FOREIGN KEY ("organization_id", "paid_from_account_id") REFERENCES "chart_of_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
