import { prisma } from '@/lib/prisma';
import { localDateString } from '@/lib/format';
import { notify } from '@/lib/notifications/service';
import { buildCompliance } from '@/lib/compliance/calendar';
import { daysBetween } from '@/lib/compliance/rules';
import { reminderStage, reminderTitle, weekOf } from '@/lib/compliance/reminder-rules';

/*
 * Reminders for every deadline on the tax & accounting calendar, so a VAT
 * return, the corporate tax return, the licence renewal or the month's
 * salaries are never late by surprise.
 *
 *   Coming up   30, 14, 7, 3 and 1 day(s) before, and on the day
 *   Late        every 3 days until it is done
 *   Monthly     salaries from the 5th (late after the 15th under WPS) and
 *               again on the 12th; the bank, depreciation and closing the
 *               month on the 10th
 *   Set-up      once a week, one message listing what is still missing
 *
 * Each goes to the bell and the phones of everyone who keeps the books
 * (Accounting → View). The notification's dedupe key sends each reminder
 * once per person however often the job runs; a stage the job missed (no
 * one opened the app that day) is sent at the next run. The calendar
 * decides what is done — file the return and the reminders stop.
 *
 * The job runs three ways, any of which is enough: the scheduled route
 * (/api/cron/compliance-reminders), the attendance route's schedule, and
 * after a page is shown to anyone in the workshop (at most every 6 hours).
 */

interface Reminder {
  dedupeKey: string;
  title: string;
  body: string;
  href: string;
}

/** What to remind one workshop of today. */
export async function remindersFor(organizationId: string, today: string): Promise<Reminder[]> {
  const calendar = await buildCompliance(organizationId, today);
  const reminders: Reminder[] = [];

  for (const item of calendar.deadlines) {
    if (!item.due || item.state === 'done' || item.state === 'none') continue;
    const stage = reminderStage(today, item.due);
    if (!stage) continue;
    const late = stage.startsWith('late');
    reminders.push({
      dedupeKey: `compliance:${item.key}:${item.due}:${stage}`,
      title: reminderTitle(item.title, item.due, today),
      body: late
        ? `${item.detail} Fines grow the longer it waits — please do it today.`
        : `${item.detail} Due ${item.due}.`,
      href: item.href ?? '/finance/calendar',
    });
  }

  const dayOfMonth = Number(today.slice(8, 10));
  const month = today.slice(0, 7);
  for (const item of calendar.monthly) {
    if (item.state !== 'todo') continue;
    const steps =
      item.key === 'payroll'
        ? [
            { from: 5, stage: 'a' },
            { from: 12, stage: 'b' },
          ]
        : [{ from: 10, stage: 'a' }];
    const step = [...steps].reverse().find((s) => dayOfMonth >= s.from);
    if (!step) continue;
    reminders.push({
      dedupeKey: `compliance:monthly:${item.key}:${month}:${step.stage}`,
      title: item.title,
      body: item.detail,
      href: item.href ?? '/finance/calendar',
    });
  }

  const missing = calendar.setup.filter((item) => item.state === 'missing');
  if (missing.length) {
    reminders.push({
      dedupeKey: `compliance:setup:${weekOf(today)}`,
      title: `${missing.length} thing${missing.length === 1 ? '' : 's'} still to set up for tax and accounting`,
      body: `${missing.map((item) => item.title).join(', ')}. Open the calendar to finish them.`,
      href: '/finance/calendar',
    });
  }
  return reminders;
}

/** Everyone who keeps the books: holds Accounting → View through a role in force. */
async function bookkeepers(organizationId: string) {
  const users = await prisma.user.findMany({
    where: {
      organizationId,
      isActive: true,
      userRoles: {
        some: {
          revokedAt: null,
          role: { rolePermissions: { some: { permission: { code: 'accounting.view' } } } },
        },
      },
    },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

/** Sends today's reminders. Safe to run as often as wanted. */
export async function runComplianceReminders(
  now = new Date(),
  /** Limit to one workshop — tests use this so they never reach real people. */
  options: { organizationId?: string } = {},
) {
  const today = localDateString(now);
  const organizations = await prisma.organization.findMany({
    where: { isActive: true, ...(options.organizationId ? { id: options.organizationId } : {}) },
    select: { id: true },
  });
  let sent = 0;
  for (const organization of organizations) {
    const [reminders, people] = await Promise.all([
      remindersFor(organization.id, today),
      bookkeepers(organization.id),
    ]);
    for (const reminder of reminders) {
      for (const userId of people) {
        const created = await notify({
          organizationId: organization.id,
          userId,
          kind: 'COMPLIANCE_REMINDER',
          ...reminder,
        });
        if (created) sent += 1;
      }
    }
  }
  return { sent };
}

const lastRun = new Map<string, number>();
const EVERY = 6 * 60 * 60 * 1000;

/**
 * Runs one workshop's reminders unless this server did so in the last 6
 * hours — called after pages are shown, so reminders arrive even with no
 * scheduler. Never throws: a reminder must not break a page.
 */
export async function maybeRunComplianceReminders(organizationId: string) {
  const now = Date.now();
  if (now - (lastRun.get(organizationId) ?? 0) < EVERY) return;
  lastRun.set(organizationId, now);
  try {
    await runComplianceReminders(new Date(now), { organizationId });
  } catch (error) {
    lastRun.delete(organizationId);
    console.error('Compliance reminders failed', error);
  }
}

// ─── The warning bar ────────────────────────────────────────────────────────

export interface UrgentItem {
  key: string;
  title: string;
  due: string;
  late: boolean;
  /** Late or due within 3 days: the whole app turns to alert until it is done. */
  alert: boolean;
  href: string;
}

const urgentCache = new Map<string, { at: number; items: UrgentItem[] }>();
const URGENT_FOR = 5 * 60 * 1000;

/**
 * What is late or due within 14 days, for the bar above every page. Kept
 * for 5 minutes per workshop; saving dates or filing a return forgets it.
 */
export async function urgentDeadlines(organizationId: string): Promise<UrgentItem[]> {
  const cached = urgentCache.get(organizationId);
  if (cached && Date.now() - cached.at < URGENT_FOR) return cached.items;
  const today = localDateString();
  const calendar = await buildCompliance(organizationId, today);
  const items = calendar.deadlines
    .filter(
      (item) =>
        item.due &&
        item.state !== 'done' &&
        item.state !== 'none' &&
        (item.state === 'late' || daysBetween(today, item.due) <= 14),
    )
    .map((item) => ({
      key: item.key,
      title: item.title,
      due: item.due!,
      late: item.state === 'late' || daysBetween(today, item.due!) < 0,
      alert: item.state === 'late' || daysBetween(today, item.due!) <= 3,
      href: item.href ?? '/finance/calendar',
    }))
    .sort((a, b) => Number(b.late) - Number(a.late) || a.due.localeCompare(b.due));
  urgentCache.set(organizationId, { at: Date.now(), items });
  return items;
}

/** Drops the cached bar after something it shows has changed. */
export function forgetUrgentDeadlines(organizationId: string) {
  urgentCache.delete(organizationId);
}
