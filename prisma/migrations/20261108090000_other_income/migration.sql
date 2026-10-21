-- Rent & other income (INC-): money the business receives that is not from
-- its workshop sales — the rent of its premises' space, a commission, scrap
-- sold. Kept apart from the workshop's tax invoices (INV-), with a receipt of
-- its own that is, when it carries VAT, the simplified tax invoice.
-- Booked as journal source OTHER_INCOME:
--
--   Dr the cash or bank account      amount received
--   Cr the income account chosen     amount less VAT
--   Cr Output VAT payable            VAT inside the amount (its tax code's rate)
--
-- In the VAT return by its VAT treatment, on the day received. Never edited:
-- a mistake is voided, which reverses its entry.
--
-- Additive only: a new table, a new enum and new enum values.

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'OTHER_INCOME';

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'OTHER_INCOME';

-- CreateEnum
CREATE TYPE "OtherIncomeStatus" AS ENUM ('POSTED', 'VOID');

-- CreateTable
CREATE TABLE "other_income" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "income_number" TEXT NOT NULL,
    "received_on" DATE NOT NULL,
    "received_from" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "income_account_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tax_code_id" UUID,
    "vat_treatment" "VatTreatment" NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "net_amount" DECIMAL(14,2) NOT NULL,
    "vat_amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" "OtherIncomeStatus" NOT NULL DEFAULT 'POSTED',
    "voided_at" TIMESTAMPTZ,
    "void_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "other_income_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "other_income_organization_id_received_on_idx" ON "other_income"("organization_id", "received_on");

-- CreateIndex
CREATE UNIQUE INDEX "other_income_organization_id_id_key" ON "other_income"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "other_income_organization_id_income_number_key" ON "other_income"("organization_id", "income_number");

-- AddForeignKey
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_organization_id_income_account_id_fkey" FOREIGN KEY ("organization_id", "income_account_id") REFERENCES "chart_of_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "chart_of_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Always some money; the parts add up; a void says why.
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_amount_positive" CHECK (amount > 0);
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_parts_add_up" CHECK (
  net_amount >= 0 AND vat_amount >= 0 AND net_amount + vat_amount = amount
);
ALTER TABLE "other_income" ADD CONSTRAINT "other_income_void_complete" CHECK (
  (status = 'VOID') = (voided_at IS NOT NULL)
);

-- Booked the moment it is recorded: like every money document, never
-- deleted — voided instead (20261018090000_booked_documents_permanent).
CREATE TRIGGER other_income_booked_permanent
  BEFORE DELETE ON "other_income"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('income receipt');
CREATE TRIGGER other_income_no_truncate BEFORE TRUNCATE ON "other_income"
  FOR EACH STATEMENT EXECUTE FUNCTION booked_documents_no_truncate();
