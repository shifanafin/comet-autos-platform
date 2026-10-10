-- UAE payroll and leave (Federal Decree-Law 33/2021 and Cabinet Resolution 1/2022).
--
--  * Leave pays by type: each leave keeps how its days are paid — full pay,
--    half pay, unpaid — decided when approved (lib/hr/leave-rules.ts).
--    New statutory types: maternity, parental, bereavement, study.
--  * Annual leave accrues with service; a balance carried in for staff who
--    joined before the books; probation and normal hours per employee.
--  * Overtime: suggested from attendance, paid once approved, at +25% or +50%.
--  * Payroll lines keep their breakdown: unpaid and half-pay days, absence,
--    leave deduction, a typed hand deduction, overtime, and the annual leave
--    owed (provisioned like the gratuity).
--  * Final settlements on leaving: gratuity, unused leave, notice, recoveries.
--
-- Rules live in the application (one tested place); the database guards
-- what must never break: leave days add up, approved payroll can't change.

-- ── Enums ──
ALTER TYPE "LeaveType" ADD VALUE IF NOT EXISTS 'MATERNITY';
ALTER TYPE "LeaveType" ADD VALUE IF NOT EXISTS 'PARENTAL';
ALTER TYPE "LeaveType" ADD VALUE IF NOT EXISTS 'BEREAVEMENT';
ALTER TYPE "LeaveType" ADD VALUE IF NOT EXISTS 'STUDY';
ALTER TYPE "AccountRole" ADD VALUE IF NOT EXISTS 'LEAVE_EXPENSE';
ALTER TYPE "AccountRole" ADD VALUE IF NOT EXISTS 'LEAVE_PROVISION';
ALTER TYPE "AccountRole" ADD VALUE IF NOT EXISTS 'STAFF_ADVANCES';
ALTER TYPE "AccountRole" ADD VALUE IF NOT EXISTS 'OTHER_INCOME';
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'FINAL_SETTLEMENT';
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'FINAL_SETTLEMENT_PAYMENT';

CREATE TYPE "OvertimeKind" AS ENUM ('NORMAL', 'NIGHT', 'REST_DAY', 'HOLIDAY');
CREATE TYPE "OvertimeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "DeductionKind" AS ENUM ('ADVANCE', 'PENALTY', 'OTHER');
CREATE TYPE "SettlementReason" AS ENUM ('RESIGNATION', 'TERMINATION', 'END_OF_CONTRACT', 'OTHER');
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- ── Organization: the weekly rest day ──
ALTER TABLE "organizations" ADD COLUMN "weekly_rest_day" SMALLINT;
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_weekly_rest_day_check" CHECK ("weekly_rest_day" BETWEEN 0 AND 6);

-- ── Employees ──
ALTER TABLE "employees"
  ADD COLUMN "probation_end_date" DATE,
  ADD COLUMN "normal_hours_per_day" DECIMAL(4,2) NOT NULL DEFAULT 8,
  ADD COLUMN "leave_opening_days" DECIMAL(6,2),
  ADD COLUMN "leave_opening_as_of" DATE;
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_normal_hours_check" CHECK ("normal_hours_per_day" > 0 AND "normal_hours_per_day" <= 12),
  ADD CONSTRAINT "employees_leave_opening_check" CHECK (
    ("leave_opening_days" IS NULL) = ("leave_opening_as_of" IS NULL)
  );

-- ── Leaves: how the days are paid ──
ALTER TABLE "leaves"
  ADD COLUMN "full_pay_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "half_pay_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unpaid_days" INTEGER NOT NULL DEFAULT 0;
-- Leave already recorded keeps how it was paid: unpaid leave unpaid, the rest in full.
UPDATE "leaves"
SET "unpaid_days" = CASE WHEN "leave_type" = 'UNPAID' THEN ("end_date" - "start_date" + 1) ELSE 0 END,
    "full_pay_days" = CASE WHEN "leave_type" = 'UNPAID' THEN 0 ELSE ("end_date" - "start_date" + 1) END;
ALTER TABLE "leaves"
  ADD CONSTRAINT "leaves_pay_split_check" CHECK (
    "full_pay_days" >= 0 AND "half_pay_days" >= 0 AND "unpaid_days" >= 0
    AND "full_pay_days" + "half_pay_days" + "unpaid_days" = ("end_date" - "start_date" + 1)
  );

-- ── Payroll lines: the breakdown ──
ALTER TABLE "payroll_items"
  ADD COLUMN "unpaid_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN "half_pay_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN "absent_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN "leave_deduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "other_deduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "other_deduction_kind" "DeductionKind",
  ADD COLUMN "other_deduction_reason" TEXT,
  ADD COLUMN "overtime_hours" DECIMAL(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN "overtime_pay" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "leave_balance_days" DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN "leave_liability" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "leave_accrual" DECIMAL(14,2) NOT NULL DEFAULT 0;
-- Lines already recorded: their deduction was the leave deduction.
UPDATE "payroll_items" SET "leave_deduction" = "deductions";
ALTER TABLE "payroll_items"
  ADD CONSTRAINT "payroll_items_breakdown_check" CHECK (
    "leave_deduction" >= 0 AND "other_deduction" >= 0 AND "overtime_pay" >= 0
    AND "deductions" = "leave_deduction" + "other_deduction"
  );

-- An approved or paid payroll is what was paid: its lines never change.
CREATE OR REPLACE FUNCTION payroll_item_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  SELECT status::text INTO run_status FROM payrolls WHERE id = COALESCE(OLD.payroll_id, NEW.payroll_id);
  IF run_status IN ('APPROVED', 'PAID') THEN
    RAISE EXCEPTION 'An approved or paid payroll can''t change (payroll_items)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payroll_item_locked
  BEFORE UPDATE OR DELETE ON "payroll_items"
  FOR EACH ROW EXECUTE FUNCTION payroll_item_locked();

-- ── Public holidays ──
CREATE TABLE "public_holidays" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "holiday_date" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "public_holidays_organization_id_holiday_date_key" ON "public_holidays"("organization_id", "holiday_date");
ALTER TABLE "public_holidays"
  ADD CONSTRAINT "public_holidays_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Overtime ──
CREATE TABLE "overtime_entries" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "work_date" DATE NOT NULL,
  "kind" "OvertimeKind" NOT NULL DEFAULT 'NORMAL',
  "hours" DECIMAL(5,2) NOT NULL,
  "status" "OvertimeStatus" NOT NULL DEFAULT 'PENDING',
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "note" TEXT,
  "decided_by_user_id" UUID,
  "decided_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "overtime_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "overtime_entries_hours_check" CHECK ("hours" > 0 AND "hours" <= 24),
  CONSTRAINT "overtime_entries_source_check" CHECK ("source" IN ('AUTO', 'MANUAL'))
);
CREATE UNIQUE INDEX "overtime_entries_organization_id_id_key" ON "overtime_entries"("organization_id", "id");
CREATE UNIQUE INDEX "overtime_entries_organization_id_employee_id_work_date_kind_key" ON "overtime_entries"("organization_id", "employee_id", "work_date", "kind");
CREATE INDEX "overtime_entries_organization_id_status_work_date_idx" ON "overtime_entries"("organization_id", "status", "work_date");
ALTER TABLE "overtime_entries"
  ADD CONSTRAINT "overtime_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "overtime_entries_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "overtime_entries_organization_id_decided_by_user_id_fkey" FOREIGN KEY ("organization_id", "decided_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Final settlements ──
CREATE TABLE "final_settlements" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "termination_date" DATE NOT NULL,
  "reason" "SettlementReason" NOT NULL,
  "service_days" INTEGER NOT NULL,
  "basic_salary" DECIMAL(14,2) NOT NULL,
  "gratuity" DECIMAL(14,2) NOT NULL,
  "gratuity_provision" DECIMAL(14,2) NOT NULL,
  "leave_days" DECIMAL(7,2) NOT NULL,
  "leave_encashment" DECIMAL(14,2) NOT NULL,
  "leave_provision" DECIMAL(14,2) NOT NULL,
  "notice_pay" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "other_additions" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "recoveries" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "net_payable" DECIMAL(14,2) NOT NULL,
  "note" TEXT,
  "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
  "approved_by_user_id" UUID,
  "approved_at" TIMESTAMPTZ,
  "paid_on" DATE,
  "paid_from_account_id" UUID,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "final_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "final_settlements_amounts_check" CHECK (
    "gratuity" >= 0 AND "gratuity_provision" >= 0 AND "leave_days" >= 0 AND "leave_encashment" >= 0
    AND "leave_provision" >= 0 AND "other_additions" >= 0 AND "recoveries" >= 0 AND "service_days" >= 0
  ),
  CONSTRAINT "final_settlements_net_check" CHECK (
    "net_payable" = "gratuity" + "leave_encashment" + "notice_pay" + "other_additions" - "recoveries"
  ),
  CONSTRAINT "final_settlements_paid_check" CHECK (("status" = 'PAID') = ("paid_on" IS NOT NULL))
);
CREATE UNIQUE INDEX "final_settlements_organization_id_id_key" ON "final_settlements"("organization_id", "id");
CREATE UNIQUE INDEX "final_settlements_organization_id_employee_id_key" ON "final_settlements"("organization_id", "employee_id");
CREATE INDEX "final_settlements_organization_id_status_idx" ON "final_settlements"("organization_id", "status");
ALTER TABLE "final_settlements"
  ADD CONSTRAINT "final_settlements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "final_settlements_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "final_settlements_organization_id_approved_by_user_id_fkey" FOREIGN KEY ("organization_id", "approved_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "final_settlements_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "final_settlements_organization_id_paid_from_account_id_fkey" FOREIGN KEY ("organization_id", "paid_from_account_id") REFERENCES "chart_of_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An approved or paid settlement is what was agreed: only its payment is recorded.
CREATE OR REPLACE FUNCTION final_settlement_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'A settlement that was approved can''t be deleted (final_settlements)';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('APPROVED', 'PAID') AND (
    NEW.gratuity, NEW.leave_encashment, NEW.notice_pay, NEW.other_additions, NEW.recoveries,
    NEW.net_payable, NEW.termination_date, NEW.employee_id
  ) IS DISTINCT FROM (
    OLD.gratuity, OLD.leave_encashment, OLD.notice_pay, OLD.other_additions, OLD.recoveries,
    OLD.net_payable, OLD.termination_date, OLD.employee_id
  ) THEN
    RAISE EXCEPTION 'An approved settlement''s figures can''t change (final_settlements)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER final_settlement_locked
  BEFORE UPDATE OR DELETE ON "final_settlements"
  FOR EACH ROW EXECUTE FUNCTION final_settlement_locked();

-- New tables, closed to the public data API like every other.
ALTER TABLE "public_holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "overtime_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "final_settlements" ENABLE ROW LEVEL SECURITY;
