-- Journal entries: corrected where they stand while the period is open,
-- numbered without gaps in date order.
--
-- Until now a booked entry could never change: a correction was a reversal
-- plus a new entry, even the same day, so a simple re-filing of an expense
-- left three entries where one belongs. Accounting software corrects an
-- entry in place while its period is open, keeping the history in the audit
-- log, and reverses only once the period is closed (a VAT return filed, the
-- year signed off). This migration lets the database follow that rule:
--
--  0. Narration — an entry's description, a line's note — moves no figure
--     and may always be corrected, in any period.
--  1. An entry may be changed or deleted only on purpose — the app sets
--     app.journal_amend = 'on' for its transaction — and never when it is
--     dated in a closed period (on or before books_closed_through), either
--     before or after the change. Anything else is refused, as before.
--  2. Debits must still equal credits after every change, not only after an
--     insert.
--  3. Entry numbers run JV-000001, 2, 3… in date order (then in the order
--     booked), with no gaps: when an entry is added, deleted or re-dated the
--     book is renumbered once, as the transaction commits. Closed periods
--     keep their numbers in practice: nothing in them can be deleted or
--     re-dated, and the only entries booked into one — a VAT return's, the
--     year-end close — are dated on its last day, after everything in it.

-- ─── 1. Changes only on purpose, only in an open period ────────────────────

CREATE OR REPLACE FUNCTION journal_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org UUID;
  dated DATE;
  closed DATE;
BEGIN
  -- A line's note is narration: it moves no figure, so it may always change.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'description' - 'updated_at') = (to_jsonb(OLD) - 'description' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.journal_amend', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Journal entries are permanent: reverse an entry instead of changing or deleting it.';
  END IF;

  IF TG_TABLE_NAME = 'journal_entries' THEN
    org := OLD.organization_id;
    dated := OLD.entry_date;
  ELSE
    SELECT organization_id, entry_date INTO org, dated
      FROM journal_entries WHERE id = OLD.journal_entry_id;
    -- The entry itself is being deleted (its lines go with it): it was checked.
    IF NOT FOUND THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  END IF;

  SELECT books_closed_through INTO closed FROM organizations WHERE id = org;
  IF closed IS NOT NULL AND dated <= closed THEN
    RAISE EXCEPTION 'The books are closed through %: an entry dated % can only be reversed, not changed.', closed, dated;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- What an entry books — its date, its source, what it reverses, its number —
-- changes only through the same deliberate path. Its narration may always
-- be corrected: it moves no figure.
CREATE FUNCTION journal_entry_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed DATE;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.reversal_of_journal_entry_id IS DISTINCT FROM OLD.reversal_of_journal_entry_id THEN
    RAISE EXCEPTION 'A journal entry''s organization, source and reversal link never change.';
  END IF;

  IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    IF current_setting('app.journal_amend', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Journal entries are permanent: reverse an entry instead of changing it.';
    END IF;
    SELECT books_closed_through INTO closed FROM organizations WHERE id = OLD.organization_id;
    IF closed IS NOT NULL AND (OLD.entry_date <= closed OR NEW.entry_date <= closed) THEN
      RAISE EXCEPTION 'The books are closed through %: an entry dated in a closed period cannot be changed.', closed;
    END IF;
  END IF;

  -- Numbers change only by renumbering the whole book in date order.
  IF NEW.entry_number IS DISTINCT FROM OLD.entry_number
     AND current_setting('app.journal_renumbering', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Journal entry numbers follow the date order and are set by the database.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_guard_update
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_guard_update();

-- ─── 2. Still balanced after every change ──────────────────────────────────

-- journal_entry_must_balance() already reads COALESCE(NEW, OLD); a deleted
-- entry sums to nothing on both sides, so deleting a whole entry passes.
CREATE CONSTRAINT TRIGGER journal_entry_lines_balance_on_change
  AFTER UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

-- ─── 3. Numbered without gaps, in date order ───────────────────────────────

-- JV- and a number, zero-padded the way the app pads it (never cut short).
CREATE FUNCTION journal_number(prefix_text TEXT, width INT, n BIGINT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT prefix_text || CASE WHEN length(n::TEXT) >= width THEN n::TEXT ELSE lpad(n::TEXT, width, '0') END
$$;

/**
 * Renumbers the organization's entries 1, 2, 3… in date order, then in the
 * order booked, and sets the counter to the number after the last. Locks
 * the counter first, as every booking does, so two transactions never
 * renumber at once. Only entries whose number changes are written.
 */
CREATE FUNCTION renumber_journal_entries(org UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  counter UUID;
  prefix_text TEXT;
  width INT;
  total INT;
BEGIN
  SELECT id, prefix, padding INTO counter, prefix_text, width
    FROM document_number_sequences
   WHERE organization_id = org AND document_type = 'JOURNAL_ENTRY' AND branch_id IS NULL
   FOR UPDATE;
  IF counter IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO total FROM journal_entries WHERE organization_id = org;

  PERFORM set_config('app.journal_renumbering', 'on', true);

  -- Through a placeholder first, so no two entries ever hold one number.
  WITH plan AS (
    SELECT id, journal_number(prefix_text, width,
             row_number() OVER (ORDER BY entry_date, created_at, id)) AS wanted
      FROM journal_entries
     WHERE organization_id = org
  )
  UPDATE journal_entries j SET entry_number = '~' || j.id::TEXT
    FROM plan p
   WHERE j.id = p.id AND j.entry_number IS DISTINCT FROM p.wanted;

  WITH plan AS (
    SELECT id, journal_number(prefix_text, width,
             row_number() OVER (ORDER BY entry_date, created_at, id)) AS wanted
      FROM journal_entries
     WHERE organization_id = org
  )
  UPDATE journal_entries j SET entry_number = p.wanted
    FROM plan p
   WHERE j.id = p.id AND starts_with(j.entry_number, '~');

  UPDATE document_number_sequences
     SET next_number = total + 1, updated_at = now()
   WHERE id = counter;

  PERFORM set_config('app.journal_renumbering', 'off', true);
END;
$$;

-- Once per organization per transaction, as it commits: a delivery booking
-- forty entries renumbers once, not forty times.
CREATE FUNCTION journal_renumber_at_commit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org UUID := COALESCE(NEW.organization_id, OLD.organization_id);
  done_key TEXT := 'app.journal_renumbered_' || replace(org::TEXT, '-', '');
BEGIN
  IF current_setting(done_key, true) = txid_current()::TEXT THEN
    RETURN NULL;
  END IF;
  PERFORM set_config(done_key, txid_current()::TEXT, true);
  PERFORM renumber_journal_entries(org);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_renumber
  AFTER INSERT OR DELETE OR UPDATE OF entry_date ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_renumber_at_commit();

-- Not callable through Supabase's public API.
REVOKE EXECUTE ON FUNCTION renumber_journal_entries(UUID) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION renumber_journal_entries(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION renumber_journal_entries(UUID) FROM authenticated;
  END IF;
END $$;
