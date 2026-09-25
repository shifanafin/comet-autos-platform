import { cache } from 'react';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hideableMenuHrefs } from '@/lib/nav';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePhone } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';

/*
 * The workshop's own details: who it is, how to reach it, and how it charges
 * VAT. These are read in two places that matter —
 *
 *   lib/documents/build.ts   the seller block on every quotation, invoice
 *                            and receipt, including the TRN on tax invoices;
 *   lib/tax.ts               the VAT rate new estimate, invoice, purchase
 *                            and expense lines default to.
 *
 * Changing the rate therefore changes what is offered next, never what has
 * already been issued: every estimate, invoice and purchase line stores the
 * rate it was priced at.
 *
 * The base currency is deliberately not editable. Every amount already
 * recorded is in it, and re-labelling them would silently misstate history.
 */

const settingsSchema = z.object({
  name: z
    .string({ error: 'Enter the workshop name.' })
    .trim()
    .min(2, 'Enter the workshop name.')
    .max(120),
  legalName: z.string().trim().max(160).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine((value) => !value || /^[+\d][\d\s()-]{5,}$/.test(value), 'Enter a valid phone number.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).optional(),
  /** The UAE TRN. Stored as digits; spaces and dashes are for reading only. */
  taxNumber: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine(
      (value) => !value || /^\d{5,20}$/.test(value.replace(/[\s-]/g, '')),
      'A TRN is 15 digits. Enter digits only.',
    ),
  isVatRegistered: z.enum(['true', 'false'], { error: 'Say whether the workshop charges VAT.' }),
  vatRate: z
    .string({ error: 'Enter the VAT rate.' })
    .trim()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a rate like 5 or 5.00.'),
  requestKey: z.string().optional(),
});

/** The settings screen's data. Reading them needs the accounting view right. */
export async function getOrganizationSettings(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: {
      id: true,
      name: true,
      legalName: true,
      address: true,
      phone: true,
      email: true,
      taxNumber: true,
      isVatRegistered: true,
      vatRate: true,
      baseCurrency: true,
      detailedJobCards: true,
      hiddenMenus: true,
      updatedAt: true,
    },
  });
  if (!organization) throw new NotFoundError('workshop');
  return { ...organization, vatRate: organization.vatRate.toFixed(2) };
}

/**
 * How the workshop chose to see the app: which job card, which menus. Any
 * signed-in user may read it — it only decides what is shown. Read once per
 * request however many places ask.
 */
export const getWorkshopPreferences = cache(async (organizationId: string) => {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { detailedJobCards: true, hiddenMenus: true },
  });
  return organization ?? { detailedJobCards: false, hiddenMenus: [] };
});

/** Whether this workshop works jobs through the standard (detailed) job card. */
export async function usesDetailedJobCards(user: AuthenticatedUser): Promise<boolean> {
  return (await getWorkshopPreferences(user.organizationId)).detailedJobCards;
}

/**
 * Saves which menus are hidden. Unknown and always-shown menus are dropped,
 * so a stale or tampered list can never hide Settings.
 */
export async function setHiddenMenus(user: AuthenticatedUser, hrefs: string[]) {
  requirePermission(user, 'accounting.edit');
  const hideable = hideableMenuHrefs();
  const hidden = [...new Set(hrefs)].filter((href) => hideable.includes(href)).sort();
  await prisma.$transaction(async (tx) => {
    const before = await tx.organization.findUnique({
      where: { id: user.organizationId },
      select: { hiddenMenus: true },
    });
    if (!before) throw new NotFoundError('workshop');
    if (before.hiddenMenus.join('\n') === hidden.join('\n')) return;
    await tx.organization.update({
      where: { id: user.organizationId },
      data: { hiddenMenus: hidden },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'organization.menus_changed',
      entityType: 'Organization',
      entityId: user.organizationId,
      beforeData: before,
      afterData: { hiddenMenus: hidden },
    });
  });
}

/**
 * Switches between the simple and the detailed job card. Only what is shown
 * changes: no job's status or history is touched, and a job already part-way
 * through the detailed steps keeps showing them.
 */
export async function setDetailedJobCards(user: AuthenticatedUser, detailed: boolean) {
  requirePermission(user, 'accounting.edit');
  await prisma.$transaction(async (tx) => {
    const before = await tx.organization.findUnique({
      where: { id: user.organizationId },
      select: { detailedJobCards: true },
    });
    if (!before) throw new NotFoundError('workshop');
    if (before.detailedJobCards === detailed) return;
    await tx.organization.update({
      where: { id: user.organizationId },
      data: { detailedJobCards: detailed },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'organization.job_card_mode_changed',
      entityType: 'Organization',
      entityId: user.organizationId,
      beforeData: before,
      afterData: { detailedJobCards: detailed },
    });
  });
}

export type OrganizationSettings = Awaited<ReturnType<typeof getOrganizationSettings>>;

/**
 * Saves the workshop's details. Only what is stored changes — no document
 * already issued is touched, and the base currency cannot be changed here.
 */
export async function updateOrganizationSettings(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(settingsSchema, rawInput);
  requirePermission(user, 'accounting.edit');

  const rate = Number(input.vatRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new DomainError('A VAT rate must be between 0 and 100.', 'vatRate');
  }
  const isVatRegistered = input.isVatRegistered === 'true';
  const data = {
    name: input.name.replace(/\s+/g, ' '),
    legalName: emptyToNull(input.legalName),
    address: emptyToNull(input.address),
    phone: input.phone ? normalizePhone(input.phone) : null,
    email: emptyToNull(input.email)?.toLowerCase() ?? null,
    taxNumber: emptyToNull(input.taxNumber)?.replace(/[\s-]/g, '') ?? null,
    isVatRegistered,
    // Kept to two decimals so it reads the same everywhere it is shown.
    vatRate: rate.toFixed(2),
  };

  const before = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: {
      name: true,
      legalName: true,
      address: true,
      phone: true,
      email: true,
      taxNumber: true,
      isVatRegistered: true,
      vatRate: true,
    },
  });
  if (!before) throw new NotFoundError('workshop');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'organization.update_settings');
    const organization = await tx.organization.update({
      where: { id: user.organizationId },
      data,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'organization.settings_updated',
      entityType: 'Organization',
      entityId: organization.id,
      beforeData: { ...before, vatRate: before.vatRate.toFixed(2) },
      afterData: data,
    });
    await settleRequestKey(tx, user, rawInput, organization.id);
    return { ...organization, vatRate: organization.vatRate.toFixed(2) };
  });
}
