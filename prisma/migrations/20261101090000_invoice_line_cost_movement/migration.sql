-- Old parts lines costed at the write-off that already costed them.
--
-- Invoices issued before parts were tied to stock have Parts lines with no
-- part and no cost, so their job profit is overstated. Most of those parts
-- had already left stock on a write-off of their own (6 Oct 2026: "historical
-- consumption"), booked to cost of sales then. cost_movement_id ties such a
-- line to that movement: the line is costed at it for the job's profit, and
-- takes nothing more out of stock and books no second cost.
--
-- Purely additive: no existing row changes.

ALTER TABLE "invoice_items" ADD COLUMN "cost_movement_id" UUID;

CREATE INDEX "invoice_items_organization_id_cost_movement_id_idx" ON "invoice_items"("organization_id", "cost_movement_id");

ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_organization_id_cost_movement_id_fkey" FOREIGN KEY ("organization_id", "cost_movement_id") REFERENCES "inventory_transactions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
