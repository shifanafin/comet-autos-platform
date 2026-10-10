import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { runComplianceReminders } from '@/lib/compliance/reminders';

/*
 * The scheduled job behind the tax & accounting reminders (VAT returns,
 * corporate tax, licence, the month's routine). Call it once or more a day —
 * Vercel Cron, Supabase pg_cron or any cron service — with the shared secret:
 *
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Running it more often is harmless: each reminder reaches each person once.
 * Without a scheduler the reminders still go out, after pages are shown.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new NextResponse('Unauthorized', { status: 401 });
  const result = await runComplianceReminders();
  return NextResponse.json({ ok: true, ...result });
}
