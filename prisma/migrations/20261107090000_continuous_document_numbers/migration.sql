-- Continuous document numbers.
--
-- The owners' rule (20–21 Oct 2026): every series runs 1, 2, 3… with no gap
-- and no wrong entry left showing.
--
--   Customer-facing series — tax invoices, credit notes, receipts, customer
--   advances, quotations, job cards — are never renumbered once issued (FTA:
--   tax invoices sequential). Only their counter is kept at the number after
--   the last, so the next one never skips.
--
--   Internal series — expenses, purchases, payment vouchers, money transfers,
--   owner's money, supplier payments — close up when a number is missing:
--   renumbered 1, 2, 3… in the order they stand, the journal's narrations
--   following, the counter set to the next number. A wrong record can be
--   removed (lib/accounting/document-numbers.ts) while its month is open, once
--   it is void and its journal entry is gone; the audit log, which is
--   permanent, keeps a full copy of it.
--
-- Two functions; the delete guards on six tables let a row go only while the
-- app has switched app.document_tidy on for its transaction. No row is
-- changed by this migration.

-- ─── 1. Closing the gaps in one series ─────────────────────────────────────

/**
 * Renumbers one internal series of an organization 1, 2, 3… in its present
 * order and returns what changed as [{ "old": …, "new": … }]. Journal
 * narrations quoting an old number are corrected (narration may always be;
 * it moves no figure). Customer-facing series are not renumbered — only their
 * counter is set to the number after the last. Locks the counter first, as
 * every new number does, so nothing is numbered meanwhile.
 */
CREATE FUNCTION close_document_number_gaps(org UUID, series "DocumentType") RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  seq RECORD;
  tbl TEXT;
  col TEXT;
  changes JSONB := '[]'::jsonb;
  pair RECORD;
  total BIGINT;
  highest BIGINT;
BEGIN
  SELECT id, prefix, padding INTO seq
  FROM document_number_sequences
  WHERE organization_id = org AND document_type = series AND branch_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN changes;
  END IF;

  tbl := CASE series
    WHEN 'EXPENSE_VOUCHER' THEN 'expenses'
    WHEN 'PURCHASE_ORDER' THEN 'purchases'
    WHEN 'PAYMENT_VOUCHER' THEN 'payment_vouchers'
    WHEN 'MONEY_TRANSFER' THEN 'money_transfers'
    WHEN 'OWNER_MONEY' THEN 'owner_money'
    WHEN 'SUPPLIER_PAYMENT' THEN 'supplier_payments'
    WHEN 'TAX_INVOICE' THEN 'invoices'
    WHEN 'CREDIT_NOTE' THEN 'credit_notes'
    WHEN 'PAYMENT_RECEIPT' THEN 'payments'
    WHEN 'CUSTOMER_ADVANCE' THEN 'customer_advances'
    WHEN 'ESTIMATE' THEN 'estimates'
    WHEN 'JOB_CARD' THEN 'job_cards'
    ELSE NULL
  END;
  col := CASE series
    WHEN 'EXPENSE_VOUCHER' THEN 'expense_number'
    WHEN 'PURCHASE_ORDER' THEN 'purchase_number'
    WHEN 'PAYMENT_VOUCHER' THEN 'voucher_number'
    WHEN 'MONEY_TRANSFER' THEN 'transfer_number'
    WHEN 'OWNER_MONEY' THEN 'entry_number'
    WHEN 'SUPPLIER_PAYMENT' THEN 'supplier_payment_number'
    WHEN 'TAX_INVOICE' THEN 'invoice_number'
    WHEN 'CREDIT_NOTE' THEN 'credit_note_number'
    WHEN 'PAYMENT_RECEIPT' THEN 'payment_number'
    WHEN 'CUSTOMER_ADVANCE' THEN 'advance_number'
    WHEN 'ESTIMATE' THEN 'estimate_number'
    WHEN 'JOB_CARD' THEN 'job_number'
    ELSE NULL
  END;
  IF tbl IS NULL THEN
    RETURN changes;
  END IF;

  IF series IN ('EXPENSE_VOUCHER', 'PURCHASE_ORDER', 'PAYMENT_VOUCHER', 'MONEY_TRANSFER',
                'OWNER_MONEY', 'SUPPLIER_PAYMENT') THEN
    -- The new number of each, in the order they stand now (the first number
    -- in the code: "PO-000013" → 13).
    EXECUTE format(
      'CREATE TEMP TABLE document_renumbering ON COMMIT DROP AS
         SELECT id, %1$I AS old_number,
                journal_number(%2$L, %3$s, row_number() OVER (ORDER BY
                  substring(%1$I FROM ''^[^0-9]*([0-9]+)'')::BIGINT, created_at, id)) AS new_number
         FROM %4$I
         WHERE organization_id = %5$L AND %1$I IS NOT NULL',
      col, seq.prefix, seq.padding, tbl, org);
    DELETE FROM document_renumbering WHERE old_number = new_number;

    IF EXISTS (SELECT 1 FROM document_renumbering) THEN
      -- Two steps, so no number is ever held by two rows at once.
      EXECUTE format(
        'UPDATE %1$I t SET %2$I = ''~'' || t.id::TEXT FROM document_renumbering r WHERE t.id = r.id',
        tbl, col);
      EXECUTE format(
        'UPDATE %1$I t SET %2$I = r.new_number FROM document_renumbering r WHERE t.id = r.id',
        tbl, col);
      -- Narrations, lowest first: each number moves down into one already vacated.
      FOR pair IN
        SELECT old_number, new_number FROM document_renumbering
        ORDER BY substring(old_number FROM '^[^0-9]*([0-9]+)')::BIGINT
      LOOP
        UPDATE journal_entries
        SET description = replace(description, pair.old_number, pair.new_number)
        WHERE organization_id = org AND description LIKE '%' || pair.old_number || '%';
      END LOOP;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('old', old_number, 'new', new_number)
                                ORDER BY substring(old_number FROM '^[^0-9]*([0-9]+)')::BIGINT),
                      '[]'::jsonb)
      INTO changes FROM document_renumbering;
    END IF;
    DROP TABLE document_renumbering;

    EXECUTE format('SELECT count(*) FROM %I WHERE organization_id = %L AND %I IS NOT NULL',
                   tbl, org, col)
    INTO total;
    UPDATE document_number_sequences
    SET next_number = total + 1, updated_at = now()
    WHERE id = seq.id AND next_number <> total + 1;
  ELSE
    -- Customer-facing: never renumbered; the next number follows the last.
    EXECUTE format(
      'SELECT max(substring(%1$I FROM ''^[^0-9]*([0-9]+)'')::BIGINT) FROM %2$I
       WHERE organization_id = %3$L AND %1$I LIKE %4$L',
      col, tbl, org, seq.prefix || '%')
    INTO highest;
    UPDATE document_number_sequences
    SET next_number = COALESCE(highest, 0) + 1, updated_at = now()
    WHERE id = seq.id AND next_number > COALESCE(highest, 0) + 1;
  END IF;

  RETURN changes;
END;
$$;

-- ─── 2. The one deliberate way a wrong internal record is removed ──────────

-- The guards stay; they let a row go only while the app has switched
-- app.document_tidy on for its transaction (lib/accounting/document-numbers.ts
-- checks: void or cancelled, no journal entry left, month open, a copy kept in
-- the audit log).
DROP TRIGGER expenses_booked_permanent ON "expenses";
CREATE TRIGGER expenses_booked_permanent
  BEFORE DELETE ON "expenses"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('expense');

DROP TRIGGER payment_vouchers_booked_permanent ON "payment_vouchers";
CREATE TRIGGER payment_vouchers_booked_permanent
  BEFORE DELETE ON "payment_vouchers"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('payment voucher');

DROP TRIGGER money_transfers_booked_permanent ON "money_transfers";
CREATE TRIGGER money_transfers_booked_permanent
  BEFORE DELETE ON "money_transfers"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('money transfer');

DROP TRIGGER owner_money_booked_permanent ON "owner_money";
CREATE TRIGGER owner_money_booked_permanent
  BEFORE DELETE ON "owner_money"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('owner''s money entry');

DROP TRIGGER supplier_payments_booked_permanent ON "supplier_payments";
CREATE TRIGGER supplier_payments_booked_permanent
  BEFORE DELETE ON "supplier_payments"
  FOR EACH ROW WHEN (current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('supplier payment');

DROP TRIGGER purchases_booked_permanent ON "purchases";
CREATE TRIGGER purchases_booked_permanent
  BEFORE DELETE ON "purchases"
  FOR EACH ROW WHEN (OLD.status NOT IN ('DRAFT', 'ORDERED', 'CANCELLED')
                     AND current_setting('app.document_tidy', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION booked_document_is_permanent('purchase');
