import type { AuthenticatedUser } from '@/lib/auth/session';
import { AuthError, hasPermission } from '@/lib/auth/authorize';
import { filsToString, toFils } from '@/lib/money';
import {
  getFinanceDashboard,
  resolvePeriod,
  type FinanceDashboardInput,
} from '@/lib/finance/dashboard';
import { getLedgerProfitAndLoss, getMonthlyProfit } from '@/lib/accounting/reports';
import { getMoneyOverview } from '@/lib/finance/money';
import { salesReport, workshopReport } from '@/lib/reports/workshop';
import { getLowStockParts, getWorkshopFlow } from '@/lib/data/dashboard';
import { comparisonOf, growth } from '@/lib/overview/compare';

/*
 * The whole garage on one screen: what it earned and kept, the money in and
 * owed both ways, and how the workshop is doing — each against the period
 * before. Every figure comes from the module that owns it (the profit and
 * loss from the books, balances from the billing rules, jobs from the
 * workshop), so the dashboard agrees with every other screen. Each part is
 * shown only to someone allowed to see it.
 */

/** A loader the user may not be allowed to run: null instead of an error. */
async function allowed<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

export async function getGarageSummary(user: AuthenticatedUser, input: FinanceDashboardInput) {
  const period = resolvePeriod(input);
  const compare = comparisonOf(period);
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const can = {
    profit: hasPermission(user, 'reports.view'),
    sales: hasPermission(user, 'invoice.view', scope),
    jobs: hasPermission(user, 'job_card.view', scope),
    money: hasPermission(user, 'money.view'),
    stock: hasPermission(user, 'inventory.view', scope),
  };

  const [
    profit,
    earlierProfit,
    trend,
    finance,
    earlierFinance,
    money,
    jobs,
    earlierJobs,
    flow,
    sales,
    lowStock,
  ] = await Promise.all([
    can.profit ? getLedgerProfitAndLoss(user, input) : null,
    can.profit ? getLedgerProfitAndLoss(user, compare.input) : null,
    can.profit ? getMonthlyProfit(user, period.to.slice(0, 7)) : null,
    allowed(() => getFinanceDashboard(user, input)),
    allowed(() => getFinanceDashboard(user, compare.input)),
    can.money ? getMoneyOverview(user) : null,
    can.jobs ? workshopReport(user, period) : null,
    can.jobs ? workshopReport(user, resolvePeriod(compare.input)) : null,
    can.jobs ? getWorkshopFlow(user.organizationId) : null,
    can.sales ? salesReport(user, period) : null,
    can.stock ? getLowStockParts(user) : null,
  ]);

  const fils = (value: string | null | undefined) =>
    value ? toFils(value.replace('-', '')) * (value.startsWith('-') ? -1 : 1) : 0;

  const pnl = profit
    ? (() => {
        const revenue = fils(profit.income.total);
        const costs = fils(profit.costOfSales.total) + fils(profit.expenses.total);
        const gross = fils(profit.grossProfit);
        const net = profit.netProfitFils;
        const before = earlierProfit!;
        return {
          revenue: profit.income.total,
          revenueGrowth: growth(revenue, fils(before.income.total)),
          grossProfit: profit.grossProfit,
          grossMargin: revenue > 0 ? Math.round((gross / revenue) * 1000) / 10 : null,
          grossGrowth: growth(gross, fils(before.grossProfit)),
          costs: filsToString(costs),
          costsGrowth: growth(costs, fils(before.costOfSales.total) + fils(before.expenses.total)),
          netProfit: profit.netProfit,
          netFils: net,
          netMargin: revenue > 0 ? Math.round((net / revenue) * 1000) / 10 : null,
          netGrowth: growth(net, before.netProfitFils),
          topExpenses: profit.expenses.rows.slice(0, 5),
        };
      })()
    : null;

  return {
    period,
    compareLabel: compare.label,
    can,
    profit: pnl,
    trend,
    money: {
      collected: finance?.revenue?.collected ?? null,
      collectedGrowth:
        finance?.revenue && earlierFinance?.revenue
          ? growth(fils(finance.revenue.collected), fils(earlierFinance.revenue.collected))
          : null,
      invoiced: finance?.revenue?.net ?? null,
      invoicedGrowth:
        finance?.revenue && earlierFinance?.revenue
          ? growth(fils(finance.revenue.net), fils(earlierFinance.revenue.net))
          : null,
      settlement: finance?.revenue?.settlement ?? null,
      receivables: finance?.receivables ?? null,
      payables: finance?.payables ?? null,
      inHand: money?.moneyNow ?? null,
    },
    jobs: jobs
      ? {
          ...jobs,
          openedGrowth: earlierJobs ? growth(jobs.opened, earlierJobs.opened) : null,
          deliveredGrowth: earlierJobs ? growth(jobs.delivered, earlierJobs.delivered) : null,
          actions: flow?.actions ?? null,
        }
      : null,
    /** Where every car is right now — not tied to the period. */
    workshopNow: flow
      ? {
          inNow: flow.vehiclesCurrentlyIn,
          appointmentsToday: flow.todaysAppointments,
          onHold: flow.onHold,
          stages: flow.workflowStages,
        }
      : null,
    sales,
    lowStock: lowStock ? lowStock.length : null,
  };
}

export type GarageSummary = Awaited<ReturnType<typeof getGarageSummary>>;
