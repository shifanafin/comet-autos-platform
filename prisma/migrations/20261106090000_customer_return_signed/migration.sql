-- A credit note's parts come back into stock as CUSTOMER_RETURN (+), and go
-- out again as CUSTOMER_RETURN (−) when the note is voided — the movement is
-- signed, like SALE (lib/inventory/credit-note-stock.ts). The first inventory
-- migration required it to be positive, so voiding a credit note that had
-- restocked parts failed. A negative one must still belong to a credit note.
-- Every existing row is positive, so it passes the new check.
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_sign_matches_type";
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_sign_matches_type" CHECK (
  CASE
    WHEN transaction_type IN ('PURCHASE_RECEIPT', 'OPENING_STOCK', 'JOB_RETURN', 'TRANSFER_IN') THEN quantity > 0
    WHEN transaction_type = 'CUSTOMER_RETURN' THEN quantity > 0 OR credit_note_id IS NOT NULL
    WHEN transaction_type IN ('JOB_CONSUMPTION', 'TRANSFER_OUT', 'RETURN_TO_SUPPLIER') THEN quantity < 0
    ELSE true
  END
);
