-- Two things for purchases:
--
-- 1. A received purchase can be corrected until its period is closed or its VAT
--    return is filed. While it is open, its receipts are corrected where they
--    stand, as every other entry is: the quantity, cost, note and date of a
--    purchase receipt, or the receipt itself when its line is removed. The app
--    asks for this inside the correction's own transaction
--    (lib/inventory/purchases.ts) and the audit log keeps what it was. Any other
--    update or delete of the stock ledger is refused as before.
--
-- 2. A purchase line may name the job its part was bought for, shown when the
--    part is picked on an invoice. It changes no figure.
--
-- Additive only: the trigger's function is replaced and one column added. No row changes.

CREATE OR REPLACE FUNCTION inventory_transactions_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.redate_purchase_receipt', true) = 'on'
    AND OLD.transaction_type = 'PURCHASE_RECEIPT'
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['created_at', 'quantity', 'unit_cost', 'note'])
      = (to_jsonb(OLD) - ARRAY['created_at', 'quantity', 'unit_cost', 'note'])
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'inventory_transactions is append-only (% refused); post a reversal or return instead', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN "job_card_id" UUID;

-- CreateIndex
CREATE INDEX "purchase_items_organization_id_job_card_id_idx" ON "purchase_items"("organization_id", "job_card_id");

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_organization_id_job_card_id_fkey" FOREIGN KEY ("organization_id", "job_card_id") REFERENCES "job_cards"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
