/*
 * When a deadline's reminders go out, as pure rules — no database.
 *
 *   Coming up   30, 14, 7, 3 and 1 day(s) before, and on the day
 *   Late        every 3 days until it is done
 *
 * A stage is sent once (lib/compliance/reminders.ts keys each by it); a
 * stage the job missed is sent at its next run, never skipped.
 */
import { addDays, daysBetween } from '@/lib/compliance/rules';

const BEFORE = [0, 1, 3, 7, 14, 30];
const LATE_EVERY = 3;

/** The reminder a deadline is at today — "due-14", "late-2" — or null before the first. */
export function reminderStage(today: string, due: string): string | null {
  const left = daysBetween(today, due);
  if (left < 0) return `late-${Math.floor((-left - 1) / LATE_EVERY)}`;
  const stage = BEFORE.find((days) => left <= days);
  return stage === undefined ? null : `due-${stage}`;
}

/** The heading for a deadline today, in plain words. */
export function reminderTitle(title: string, due: string, today: string): string {
  const left = daysBetween(today, due);
  if (left < 0) return `Late: ${title}`;
  if (left === 0) return `Due today: ${title}`;
  if (left === 1) return `Due tomorrow: ${title}`;
  return `Due in ${left} days: ${title}`;
}

/** Monday of the week a day falls in: the key for weekly reminders. */
export function weekOf(day: string) {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}
