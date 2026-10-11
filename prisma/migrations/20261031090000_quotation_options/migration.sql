-- Quotation versions as options.
--
-- Until now a new version always replaced the one before: its customer link
-- stopped working and only the newest version could be approved. A workshop
-- also uses versions as options for the customer (genuine or aftermarket
-- parts, say), so a new version may now leave the one before open. The
-- customer — on its link — or staff may approve any open version; approving
-- one closes the others.
--
--   is_current   the version that counts: listed, invoiced, shared. The
--                newest, until an older open version is the one approved.
--   replaced_at  when a sent version was replaced (a correction) or not
--                chosen (another option was approved). A sent version
--                without it is still open.
--
-- Existing data: the newest version of each chain is current. Older sent
-- versions are left open (replaced_at empty): their links were already
-- withdrawn, so only staff can approve one, or issue it a new link — which
-- is what the workshop asked for. Purely additive otherwise.

ALTER TABLE "estimates"
  ADD COLUMN "is_current" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "replaced_at" TIMESTAMPTZ;

UPDATE "estimates" e
SET "is_current" = false
WHERE EXISTS (
  SELECT 1 FROM "estimates" n
  WHERE n."organization_id" = e."organization_id" AND n."previous_version_id" = e."id"
);

CREATE INDEX "estimates_organization_id_is_current_idx" ON "estimates"("organization_id", "is_current");
