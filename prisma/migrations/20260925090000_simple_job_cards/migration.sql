-- Workshop display preferences.
--
--   A. Work orders open as the minimal job card unless the workshop turns
--      the standard, step-by-step job card on (once there is a team to
--      split the steps between).
--   B. Menu items the workshop chose not to show.
--
-- Purely additive and display-only: two columns with defaults. No status,
-- transition, permission or document reads them; every job keeps its
-- history either way.

ALTER TABLE "organizations" ADD COLUMN "detailed_job_cards" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hidden_menus" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
