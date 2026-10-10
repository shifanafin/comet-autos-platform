-- 20261020090000_controlled_parts_stock failed part-way on its first run on
-- the hosted database: the bill_status column was added (default PENDING)
-- but its closing backfill — "what was recorded before this change keeps
-- exactly its booking" — never ran. Purchases recorded before it were
-- booked with their input VAT straight in "Input VAT recoverable", yet
-- still read as awaiting their tax invoice, so the VAT return left that VAT
-- out while the ledger had it. This finishes the backfill, for exactly the
-- purchases created before that migration was applied:
--
--   * with the supplier's invoice number, or with VAT on them: RECEIVED, on
--     the invoice date (else the day received) — as the backfill would have;
--   * no invoice number and no VAT (bought without a tax invoice): closed
--     as NO_TAX_INVOICE.
--
-- Nothing is re-booked: their entries already claim the VAT. Each change is
-- written to the audit log. On a database where that migration ran whole,
-- no purchase predates it and nothing changes. Safe to run again.

WITH cutoff AS (
  SELECT min(finished_at) AS at
  FROM _prisma_migrations
  WHERE migration_name = '20261020090000_controlled_parts_stock'
    AND finished_at IS NOT NULL
),
fixed AS (
  UPDATE purchases p
  SET bill_status = CASE
        WHEN p.supplier_invoice_number IS NULL AND COALESCE(p.tax_amount, 0) = 0
          THEN 'NO_TAX_INVOICE'::"PurchaseBillStatus"
        ELSE 'RECEIVED'::"PurchaseBillStatus"
      END,
      bill_received_on = COALESCE(
        p.supplier_invoice_date,
        (p.received_at AT TIME ZONE 'Asia/Dubai')::date,
        (p.ordered_at AT TIME ZONE 'Asia/Dubai')::date
      ),
      bill_note = CASE
        WHEN p.supplier_invoice_number IS NULL AND COALESCE(p.tax_amount, 0) = 0
          THEN 'Bought without a tax invoice (recorded before bills were tracked).'
        ELSE p.bill_note
      END
  FROM cutoff
  WHERE p.bill_status = 'PENDING'
    AND p.bill_matched_by_user_id IS NULL
    AND p.status <> 'CANCELLED'
    AND p.created_at < cutoff.at
  RETURNING p.id, p.organization_id, p.branch_id, p.purchase_number, p.bill_status,
            p.bill_received_on, p.supplier_invoice_number
)
INSERT INTO audit_logs (id, organization_id, branch_id, action, entity_type, entity_id, before_data, after_data, metadata)
SELECT
  gen_random_uuid(),
  f.organization_id,
  f.branch_id,
  'purchase.bill_status_backfilled',
  'Purchase',
  f.id,
  jsonb_build_object('billStatus', 'PENDING'),
  jsonb_build_object(
    'billStatus', f.bill_status::text,
    'billReceivedOn', f.bill_received_on,
    'supplierInvoiceNumber', f.supplier_invoice_number
  ),
  jsonb_build_object(
    'purchaseNumber', f.purchase_number,
    'reason', 'Finishing the bill-status backfill of 20261020090000_controlled_parts_stock'
  )
FROM fixed f;
