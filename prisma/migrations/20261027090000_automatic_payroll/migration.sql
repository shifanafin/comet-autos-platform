-- Payroll that runs by itself: on the 1st the app calculates last month's
-- payroll, and the people who approve it are told. A run the app made has
-- no person behind it, so who ran it may be empty; "automatic" says so.
-- Every run already recorded keeps its person and stays automatic = false.

ALTER TABLE "payrolls"
  ALTER COLUMN "created_by_user_id" DROP NOT NULL,
  ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false;

-- A run is made by a person, or by the app — one or the other.
ALTER TABLE "payrolls"
  ADD CONSTRAINT "payrolls_made_by_someone_or_automatic"
    CHECK ("automatic" OR "created_by_user_id" IS NOT NULL);
