-- Enters MOHAMMED MOWLA AUTO GARAGE L.L.C's dates for the tax & accounting
-- calendar, from its FTA certificates and trade licence:
--
--   VAT (certificate issued 09/02/2026, TRN 105296057000003)
--     effective 01/02/2026; first return period 01/02/2026 – 30/04/2026;
--     quarterly: Feb–Apr, May–Jul, Aug–Oct, Nov–Jan.
--   Corporate tax (EmaraTax registration)
--     tax period January – December; first period 01/12/2025 – 31/12/2026,
--     which ends on the usual 31 December, so no separate first-year end.
--   Trade licence 918045 (Dubai Economy and Tourism), expires 12/12/2026.
--
-- Touches only the workshop with that TRN, and stops if it doesn't find
-- exactly one. Logged in the audit trail like a change made on screen.
-- Safe to run again. The corporate tax number and the WPS details are
-- entered on screen once known (Finance → Tax & accounting calendar).
--
-- Run it whole in the Supabase SQL editor, or:
--   npx prisma db execute --file prisma/set-company-dates.sql --schema=./prisma/schema.prisma

BEGIN;

DO $$
DECLARE
  workshop uuid;
  matches integer;
  before jsonb;
BEGIN
  SELECT count(*) INTO matches
  FROM organizations
  WHERE tax_number = '105296057000003' AND is_active;
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active workshop with TRN 105296057000003, found %', matches;
  END IF;

  SELECT id,
         jsonb_build_object(
           'financialYearEndMonth', financial_year_end_month,
           'firstFinancialYearEnd', first_financial_year_end,
           'vatFirstPeriodStart', vat_first_period_start,
           'vatFirstPeriodEnd', vat_first_period_end,
           'vatPeriodMonths', vat_period_months,
           'tradeLicenceNumber', trade_licence_number,
           'tradeLicenceExpiry', trade_licence_expiry
         )
    INTO workshop, before
  FROM organizations
  WHERE tax_number = '105296057000003' AND is_active;

  UPDATE organizations
  SET financial_year_end_month = 12,
      first_financial_year_end = NULL,
      vat_first_period_start = DATE '2026-02-01',
      vat_first_period_end = DATE '2026-04-30',
      vat_period_months = 3,
      trade_licence_number = '918045',
      trade_licence_expiry = DATE '2026-12-12',
      updated_at = now()
  WHERE id = workshop;

  INSERT INTO audit_logs (id, organization_id, action, entity_type, entity_id, before_data, after_data, metadata)
  VALUES (
    gen_random_uuid(),
    workshop,
    'organization.company_dates_updated',
    'Organization',
    workshop,
    before,
    jsonb_build_object(
      'financialYearEndMonth', 12,
      'firstFinancialYearEnd', NULL,
      'vatFirstPeriodStart', '2026-02-01',
      'vatFirstPeriodEnd', '2026-04-30',
      'vatPeriodMonths', 3,
      'tradeLicenceNumber', '918045',
      'tradeLicenceExpiry', '2026-12-12'
    ),
    jsonb_build_object('source', 'prisma/set-company-dates.sql — from the VAT certificate, corporate tax registration and trade licence')
  );
END $$;

COMMIT;
