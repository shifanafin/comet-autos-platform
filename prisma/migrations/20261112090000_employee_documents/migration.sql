-- Employee documents: the papers a UAE employer keeps for each person —
-- passport, visa, Emirates ID, work permit, labour contract, insurance,
-- licence, certificates — each with its number and dates, so an expiry is
-- seen before it lapses. The copies themselves (front, back, PDF) are kept
-- in "documents" with entity_type 'EmployeeDocument' and entity_id the row
-- here, through the same private, permission-checked storage as bills.
--
-- Additive only: a new enum and a new table. No existing row changes.

-- CreateEnum
CREATE TYPE "EmployeeDocumentKind" AS ENUM ('PASSPORT', 'VISA', 'EMIRATES_ID', 'WORK_PERMIT', 'LABOUR_CONTRACT', 'OFFER_LETTER', 'HEALTH_INSURANCE', 'ILOE', 'DRIVING_LICENCE', 'CERTIFICATE', 'PHOTO', 'BANK_DETAILS', 'OTHER');

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "EmployeeDocumentKind" NOT NULL,
    "document_number" TEXT,
    "issue_date" DATE,
    "expiry_date" DATE,
    "notes" TEXT,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_documents_organization_id_employee_id_idx" ON "employee_documents"("organization_id", "employee_id");

-- CreateIndex
CREATE INDEX "employee_documents_organization_id_expiry_date_idx" ON "employee_documents"("organization_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_documents_organization_id_id_key" ON "employee_documents"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
