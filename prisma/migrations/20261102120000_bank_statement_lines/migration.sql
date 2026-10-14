-- Bank statements uploaded to a reconciliation.
--
-- A statement downloaded from online banking (or a card company's settlement
-- report) is uploaded to a reconciliation; each of its lines is kept as the
-- bank wrote it and matched to the book lines it clears. The tick that
-- clears a book line (reconciled_lines) names the statement line it matched.
-- How each account's file is laid out is remembered on the account, so the
-- next month's upload needs no choosing.
--
-- Purely additive: new nullable columns and a new table; no existing row
-- changes.

-- AlterTable
ALTER TABLE "chart_of_accounts" ADD COLUMN     "statement_columns" JSONB;

-- AlterTable
ALTER TABLE "bank_reconciliations" ADD COLUMN     "statement_file_name" TEXT,
ADD COLUMN     "statement_opening" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "reconciled_lines" ADD COLUMN     "statement_line_id" UUID;

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reconciliation_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "line_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2),
    "brought_forward" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_lines_organization_id_reconciliation_id_posi_idx" ON "bank_statement_lines"("organization_id", "reconciliation_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_organization_id_id_key" ON "bank_statement_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "reconciled_lines_organization_id_statement_line_id_idx" ON "reconciled_lines"("organization_id", "statement_line_id");

-- AddForeignKey
ALTER TABLE "reconciled_lines" ADD CONSTRAINT "reconciled_lines_organization_id_statement_line_id_fkey" FOREIGN KEY ("organization_id", "statement_line_id") REFERENCES "bank_statement_lines"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_reconciliation_id_fkey" FOREIGN KEY ("organization_id", "reconciliation_id") REFERENCES "bank_reconciliations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Closed to Supabase's public data API like every other table.
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY;
