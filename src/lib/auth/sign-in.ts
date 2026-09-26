import { prisma } from '@/lib/prisma';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  clearFailures,
  lockedMinutes,
  recordFailure,
  throttleKey,
  tooManyAttemptsMessage,
  type ThrottleRule,
} from '@/lib/auth/throttle';
import { phoneCore } from '@/lib/normalize';

/*
 * Checking a staff sign-in. Kept apart from the form action so the rules —
 * the same answer for a wrong account and a wrong password, the guessing
 * limits, the safe return address — are tested directly.
 */

export const INVALID_CREDENTIALS_MESSAGE = 'Email/mobile number or password is incorrect.';

// Five wrong passwords for one account locks it for 15 minutes. The looser
// per-address limit catches one device trying many accounts, without
// locking out a whole workshop that shares one internet connection.
const ACCOUNT_LIMIT = { maxFailures: 5, windowMinutes: 15, lockoutMinutes: 15 };
const ADDRESS_LIMIT = { maxFailures: 30, windowMinutes: 15, lockoutMinutes: 15 };

/**
 * Finds the active user by email, or by mobile number (compared on its
 * national digits, so "050 123 4567" and "+971501234567" match). The workshop
 * is a single-business deployment, so there is exactly one organization.
 */
async function findUser(identifier: string) {
  if (identifier.includes('@')) {
    return prisma.user.findFirst({ where: { email: identifier.toLowerCase(), isActive: true } });
  }
  const core = phoneCore(identifier);
  if (core.length < 7) return null;
  const candidates = await prisma.user.findMany({
    where: { isActive: true, phone: { not: null } },
    select: { id: true, phone: true },
  });
  const matches = candidates.filter((candidate) => phoneCore(candidate.phone!) === core);
  // Ambiguous numbers are refused rather than guessed.
  return matches.length === 1 ? prisma.user.findUnique({ where: { id: matches[0].id } }) : null;
}

// A real bcrypt hash to check against when there is no such account, so a
// wrong email takes as long to refuse as a wrong password.
let decoyHash: Promise<string> | null = null;
const decoy = () => (decoyHash ??= hashPassword('comet-autos-no-such-account'));

export type SignInResult =
  { ok: true; user: { id: string; organizationId: string } } | { ok: false; error: string };

export async function authenticate(
  rawIdentifier: string,
  password: string,
  address: string,
): Promise<SignInResult> {
  const identifier = rawIdentifier.trim();
  if (!identifier || !password) {
    return { ok: false, error: 'Enter your email or mobile number and your password.' };
  }

  // Phone numbers are counted by their digits, so spacing can't reset the count.
  const accountKey = throttleKey(
    'login',
    identifier.includes('@') ? identifier : phoneCore(identifier) || identifier,
  );
  // An unknown address would pool every caller into one count; skip that rule.
  const rules: ThrottleRule[] = [
    { key: accountKey, ...ACCOUNT_LIMIT },
    ...(address && address !== 'unknown'
      ? [{ key: throttleKey('login-address', address), ...ADDRESS_LIMIT }]
      : []),
  ];

  // Locked keys are refused before any password is checked.
  const locked = await lockedMinutes(rules.map((rule) => rule.key));
  if (locked !== null) return { ok: false, error: tooManyAttemptsMessage(locked) };

  const user = await findUser(identifier);
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await decoy()));
  if (!user || !passwordOk) {
    const nowLocked = await recordFailure(rules);
    return {
      ok: false,
      error: nowLocked !== null ? tooManyAttemptsMessage(nowLocked) : INVALID_CREDENTIALS_MESSAGE,
    };
  }

  await clearFailures([accountKey]);
  return { ok: true, user: { id: user.id, organizationId: user.organizationId } };
}

/**
 * Where to go after signing in: a path on this site only. Refuses other
 * sites however they are spelled — `//evil.com`, and `/\evil.com`, which
 * browsers also read as another site.
 */
export function safeReturnPath(value: unknown): string {
  const next = typeof value === 'string' ? value : '';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  if (next === '/login' || next.startsWith('/login/') || next.startsWith('/login?')) return '/';
  return next;
}
