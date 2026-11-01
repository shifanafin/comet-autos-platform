-- A purchase entered after the day it happened: correcting its date also moves
-- the day its stock came in, so stock, VAT and cash fall in the right month.
--
-- The stock ledger stays append-only. The one exception is the date of a
-- purchase receipt, and only when the app asks for it inside the correction's
-- own transaction (lib/inventory/purchases.ts): every other column must stay
-- exactly as it was, and any other update or delete is refused as before. The
-- audit log keeps each move.
--
-- Additive only: the trigger's function is replaced. No row changes.

CREATE OR REPLACE FUNCTION inventory_transactions_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('app.redate_purchase_receipt', true) = 'on'
    AND OLD.transaction_type = 'PURCHASE_RECEIPT'
    AND (to_jsonb(NEW) - 'created_at') = (to_jsonb(OLD) - 'created_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'inventory_transactions is append-only (% refused); post a reversal or return instead', TG_OP;
END;
$$ LANGUAGE plpgsql;
