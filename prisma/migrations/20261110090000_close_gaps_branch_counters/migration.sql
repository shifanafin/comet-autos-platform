-- close_document_number_gaps (20261107090000_continuous_document_numbers)
-- looked only for a workshop-wide counter (branch_id IS NULL). Most series
-- are counted per branch (EXP, PV, PO, SP, INV, RCT, ADV…), so for them it
-- did nothing. Now it uses the series' one counter, whichever it is, and
-- refuses a series counted separately in more than one branch.
--
-- Replaces the function only; no row is changed by this migration.

CREATE OR REPLACE FUNCTION close_document_number_gaps(org UUID, series "DocumentType") RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  seq RECORD;
  tbl TEXT;
  col TEXT;
  changes JSONB := '[]'::jsonb;
  pair RECORD;
  total BIGINT;
  highest BIGINT;
  counters INT;
BEGIN
  -- The series' counter, workshop-wide or the branch's: renumbering runs
  -- over the whole workshop, so a series counted per branch in more than one
  -- branch is refused rather than numbered across them.
  SELECT COUNT(*) INTO counters
  FROM document_number_sequences
  WHERE organization_id = org AND document_type = series;
  IF counters = 0 THEN
    RETURN changes;
  END IF;
  IF counters > 1 THEN
    RAISE EXCEPTION 'Series % has % counters (one per branch): close its gaps branch by branch.', series, counters;
  END IF;
  SELECT id, prefix, padding INTO seq
  FROM document_number_sequences
  WHERE organization_id = org AND document_type = series
  FOR UPDATE;

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
