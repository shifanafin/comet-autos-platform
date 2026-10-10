import { z } from 'zod';
import type { NotificationKind } from '@/generated/prisma/enums';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { DomainError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { pushToUser } from '@/lib/notifications/push';

/*
 * Notifications: the bell in the top bar, and the same message pushed to
 * the person's phones.
 *
 * A notification belongs to one login. It stays in the bell until the
 * person removes it — opening it only marks it read — so it can be kept as
 * a reminder. Reminders carry a dedupe key ("checkin:2026-10-05") so the
 * scheduled job can run as often as it likes and still send each one once.
 */

export interface NewNotification {
  organizationId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  dedupeKey?: string | null;
}

/**
 * Records a notification and pushes it. Returns null when one with the same
 * dedupe key was already sent to this person. Never throws for the push.
 */
export async function notify(input: NewNotification) {
  let created;
  try {
    created = await prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        body: input.body?.slice(0, 500) ?? null,
        href: input.href ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
      select: { id: true, kind: true, title: true, body: true, href: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
  await pushToUser(input.organizationId, input.userId, created);
  return created;
}

/** The person's notifications that they haven't removed, newest first. */
export async function listMyNotifications(user: AuthenticatedUser) {
  return prisma.notification.findMany({
    where: { organizationId: user.organizationId, userId: user.id, dismissedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: { id: true, kind: true, title: true, body: true, href: true, readAt: true, createdAt: true },
  });
}

export type MyNotification = Awaited<ReturnType<typeof listMyNotifications>>[number];

/** The number on the bell. */
export async function countUnread(user: AuthenticatedUser) {
  return prisma.notification.count({
    where: { organizationId: user.organizationId, userId: user.id, dismissedAt: null, readAt: null },
  });
}

const mine = (user: AuthenticatedUser) => ({ organizationId: user.organizationId, userId: user.id });

/** Opening one marks it read, and says where it leads. */
export async function openNotification(user: AuthenticatedUser, id: string) {
  const notification = await prisma.notification.findFirst({
    where: { id, ...mine(user) },
    select: { id: true, href: true, readAt: true },
  });
  if (!notification) return null;
  if (!notification.readAt) {
    await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
  }
  return notification;
}

export async function markAllRead(user: AuthenticatedUser) {
  await prisma.notification.updateMany({
    where: { ...mine(user), readAt: null },
    data: { readAt: new Date() },
  });
}

/** Removes one from the list (kept on record). */
export async function dismissNotification(user: AuthenticatedUser, id: string) {
  await prisma.notification.updateMany({
    where: { id, ...mine(user), dismissedAt: null },
    data: { dismissedAt: new Date(), readAt: new Date() },
  });
}

/** Removes every one from the list. */
export async function dismissAll(user: AuthenticatedUser) {
  const now = new Date();
  await prisma.notification.updateMany({
    where: { ...mine(user), dismissedAt: null },
    data: { dismissedAt: now },
  });
}

// ─── Devices ────────────────────────────────────────────────────────────────

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(10).max(500),
    auth: z.string().min(4).max(500),
  }),
});

/** Chrome/Android, Safari/iOS, Firefox and Edge push services — nothing else. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
function isPushService(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

/** Remembers this device, so pushes reach it. Re-subscribing the same device updates it. */
export async function savePushSubscription(user: AuthenticatedUser, raw: unknown, userAgent: string | null) {
  const input = parseInput(subscriptionSchema, raw);
  // Only the browsers' own push services: the server posts to this address.
  if (!isPushService(input.endpoint)) throw new DomainError('That device can’t receive notifications.');
  await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    update: {
      organizationId: user.organizationId,
      userId: user.id,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
    create: {
      organizationId: user.organizationId,
      userId: user.id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
  });
}

export async function removePushSubscription(user: AuthenticatedUser, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { ...mine(user), endpoint } });
}
