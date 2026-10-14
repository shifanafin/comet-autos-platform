-- Money a partner paid to buy the business itself.
--
-- The partners bought the company from its previous owner: the price and
-- the fees of transferring it were paid out of their own pockets, to him
-- and to Tasheel. The company paid and received nothing, so none of it is in
-- its books — no journal entry, no profit effect, nothing for corporate tax.
-- It is kept here, per partner, so each one's whole investment shows beside
-- the money they put into the company (Money → Owner's money).
--
-- Additive only: a new table. No existing row changes.

CREATE TABLE "business_purchase_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "paid_to" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "voided_at" TIMESTAMPTZ,
    "void_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "business_purchase_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_purchase_payments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "business_purchase_payments_text_present" CHECK (length(trim("paid_to")) > 0 AND length(trim("description")) > 0)
);

CREATE UNIQUE INDEX "business_purchase_payments_organization_id_id_key" ON "business_purchase_payments"("organization_id", "id");
CREATE INDEX "business_purchase_payments_organization_id_partner_id_idx" ON "business_purchase_payments"("organization_id", "partner_id");

ALTER TABLE "business_purchase_payments" ADD CONSTRAINT "business_purchase_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_purchase_payments" ADD CONSTRAINT "business_purchase_payments_organization_id_partner_id_fkey" FOREIGN KEY ("organization_id", "partner_id") REFERENCES "partners"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_purchase_payments" ADD CONSTRAINT "business_purchase_payments_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed to Supabase's public data API, as every table is.
ALTER TABLE "business_purchase_payments" ENABLE ROW LEVEL SECURITY;
