-- Removes the other_income table (20261108090000_other_income), no longer
-- used. Refuses while any of its records still stands or still has a journal
-- entry. The enum values JournalSource.OTHER_INCOME and
-- DocumentType.OTHER_INCOME stay, unused: Postgres can't drop an enum value
-- without rebuilding the type under every column and function that uses it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE source_type = 'OTHER_INCOME') THEN
    RAISE EXCEPTION 'Journal entries still point at other_income records: run prisma/one-off/retire-rent-income-2026-10-22.ts --apply first.';
  END IF;
  IF EXISTS (SELECT 1 FROM other_income WHERE status <> 'VOID') THEN
    RAISE EXCEPTION 'An other_income record still stands: void it first.';
  END IF;
END;
$$;

DROP TABLE "other_income";
DROP TYPE "OtherIncomeStatus";

DELETE FROM document_number_sequences WHERE document_type = 'OTHER_INCOME';

-- Its income account, where nothing is booked to it: switched off (a void
-- invoice line may still name it, so it stays).
UPDATE chart_of_accounts a
SET is_active = false, updated_at = now()
WHERE a.account_name = 'Rental income — workshop space'
  AND a.role IS NULL
  AND NOT EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.chart_of_account_id = a.id);
