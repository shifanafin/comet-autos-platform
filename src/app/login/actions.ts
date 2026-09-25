'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { authenticate, safeReturnPath } from '@/lib/auth/sign-in';
import { clientAddress } from '@/lib/auth/throttle';

export interface LoginState {
  error?: string;
  /** What the user typed as their email or mobile, so a failed attempt doesn't clear it. */
  identifier?: string;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get('identifier') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  const result = await authenticate(identifier, password, await clientAddress());
  if (!result.ok) return { identifier, error: result.error };

  const rawToken = await createSession(result.user.id, result.user.organizationId);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });

  await prisma.user.update({ where: { id: result.user.id }, data: { lastLoginAt: new Date() } });

  redirect(safeReturnPath(formData.get('next')));
}
