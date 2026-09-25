import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';

/*
 * Limits on guessing: a staff password, or the registration + mobile number
 * that opens a customer's link. Each rule counts failures for one key
 * (a sign-in name, a link, a network address) and locks that key for a
 * while once it reaches its limit. Counting and locking happen in one SQL
 * function (record_auth_failure), so parallel guesses can't slip past.
 *
 * Keys are hashed before they are stored: the table never holds an email,
 * a phone number or an IP address.
 */

export interface ThrottleRule {
  key: string;
  maxFailures: number;
  windowMinutes: number;
  lockoutMinutes: number;
}

export function throttleKey(scope: string, value: string): string {
  return `${scope}:${createHash('sha256').update(value.trim().toLowerCase()).digest('hex')}`;
}

/**
 * The limiter guards sign-in; it must never be what breaks it. If its table
 * is unreachable — say, a deploy that ran before its migration — the error
 * is logged and the password check alone decides, as it did before.
 */
async function guarded<T>(fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error('[auth-throttle] limiter unavailable; continuing without it', error);
    return fallback;
  }
}

// Time is the database's throughout: it sets the locks, so it also says how
// long is left — in whole minutes, so no timestamp crosses a time zone.

/** Minutes left on the longest lock among these keys, or null when none is locked. */
export async function lockedMinutes(keys: string[]): Promise<number | null> {
  return guarded(null, async () => {
    const [row] = await prisma.$queryRaw<{ minutes: number | null }[]>`
    SELECT ceil(extract(epoch FROM max(locked_until) - now()) / 60)::int AS minutes
    FROM auth_throttles
    WHERE key = ANY(${keys}::text[]) AND locked_until > now()`;
    return row?.minutes == null ? null : Math.max(1, row.minutes);
  });
}

/** Counts one failure against every rule; minutes locked if that failure locked any key. */
export async function recordFailure(rules: ThrottleRule[]): Promise<number | null> {
  return guarded(null, async () => {
    let minutes: number | null = null;
    for (const rule of rules) {
      const [row] = await prisma.$queryRaw<{ minutes: number | null }[]>`
      SELECT ceil(extract(epoch FROM record_auth_failure(
        ${rule.key},
        ${rule.maxFailures}::int,
        make_interval(mins => ${rule.windowMinutes}::int),
        make_interval(mins => ${rule.lockoutMinutes}::int)
      ) - now()) / 60)::int AS minutes`;
      if (row?.minutes != null) minutes = Math.max(minutes ?? 1, row.minutes);
    }
    return minutes;
  });
}

/** Forgets failures after a success, so a later typo starts from a clean count. */
export async function clearFailures(keys: string[]): Promise<void> {
  await guarded(undefined, async () => {
    await prisma.authThrottle.deleteMany({ where: { key: { in: keys } } });
  });
}

/**
 * The caller's network address, as the hosting proxy reports it. Only a
 * second line of defence — it can be shared (a workshop's Wi-Fi) or, off a
 * trusted proxy, forged — so every rule keyed on it is looser than the one
 * keyed on the account or link itself.
 */
export async function clientAddress(): Promise<string> {
  const list = await headers();
  return (
    list.get('x-forwarded-for')?.split(',')[0]?.trim() || list.get('x-real-ip')?.trim() || 'unknown'
  );
}

export function tooManyAttemptsMessage(minutes: number): string {
  return `Too many attempts. For your security, try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
