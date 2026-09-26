import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePhone, phoneCore } from '@/lib/normalize';
import { findMatchingIds } from '@/lib/customers/search';

export const customerSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required.').max(200, 'Name is too long.'),
  phone: z
    .string({ error: 'Mobile number is required.' })
    .trim()
    .min(1, 'Mobile number is required.')
    .refine((value) => /^[+\d\s()-]+$/.test(value), 'Use digits only for the mobile number.')
    .refine((value) => phoneCore(value).length >= 7, 'Enter a complete mobile number.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).optional(),
  address: z.string().trim().max(500).optional(),
  taxNumber: z.string().trim().max(50).optional(),
});

export type CustomerInput = z.input<typeof customerSchema>;

function toCustomerData(input: z.infer<typeof customerSchema>) {
  return {
    name: input.name,
    phone: normalizePhone(input.phone),
    email: emptyToNull(input.email),
    address: emptyToNull(input.address),
    taxNumber: emptyToNull(input.taxNumber),
  };
}

export async function createCustomer(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  rawInput: CustomerInput,
) {
  requirePermission(user, 'customer.create');
  const data = toCustomerData(parseInput(customerSchema, rawInput));
  const customer = await tx.customer.create({
    data: { organizationId: user.organizationId, ...data },
  });
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: user.primaryBranchId,
    actorUserId: user.id,
    action: 'customer.created',
    entityType: 'Customer',
    entityId: customer.id,
    afterData: data,
  });
  return customer;
}

export async function updateCustomer(
  user: AuthenticatedUser,
  customerId: string,
  rawInput: CustomerInput,
) {
  requirePermission(user, 'customer.edit');
  const data = toCustomerData(parseInput(customerSchema, rawInput));
  return prisma.$transaction(async (tx) => {
    const before = await tx.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
    });
    if (!before) throw new NotFoundError('customer');
    const customer = await tx.customer.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'customer.updated',
      entityType: 'Customer',
      entityId: customer.id,
      beforeData: {
        name: before.name,
        phone: before.phone,
        email: before.email,
        address: before.address,
        taxNumber: before.taxNumber,
      },
      afterData: data,
    });
    return customer;
  });
}

/** Other customers already using this mobile number — shown as a warning, never a hard block (families and fleets share numbers). */
export async function findCustomersByPhone(
  user: AuthenticatedUser,
  phone: string,
  excludeCustomerId?: string,
) {
  requirePermission(user, 'customer.view');
  const core = phoneCore(phone);
  if (core.length < 7) return [];
  const { customerIds } = await findMatchingIds(user.organizationId, core, 5);
  if (customerIds.length === 0) return [];
  const customers = await prisma.customer.findMany({
    where: { id: { in: customerIds }, organizationId: user.organizationId },
    select: { id: true, name: true, phone: true },
  });
  return customers.filter((c) => c.id !== excludeCustomerId && phoneCore(c.phone) === core);
}

export async function listCustomers(
  user: AuthenticatedUser,
  query: string,
  take = 50,
  /** The deleted (archived) customers instead, to find one to restore. */
  deleted = false,
) {
  requirePermission(user, 'customer.view');
  const trimmed = query.trim();
  if (deleted) {
    return prisma.customer.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: false,
        ...(trimmed
          ? {
              OR: [
                { name: { contains: trimmed, mode: 'insensitive' } },
                { phone: { contains: trimmed } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        createdAt: true,
        vehicles: {
          select: { id: true, plateNumber: true, make: true, model: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }
  const ids =
    trimmed.length >= 2
      ? (await findMatchingIds(user.organizationId, trimmed, take)).customerIds
      : null;
  if (ids && ids.length === 0) return [];

  return prisma.customer.findMany({
    where: {
      organizationId: user.organizationId,
      isActive: true,
      ...(ids ? { id: { in: ids } } : {}),
    },
    orderBy: ids ? { name: 'asc' } : { createdAt: 'desc' },
    take,
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      createdAt: true,
      vehicles: {
        where: { isActive: true },
        select: { id: true, plateNumber: true, make: true, model: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

export async function getCustomerDetail(user: AuthenticatedUser, customerId: string) {
  requirePermission(user, 'customer.view');
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId: user.organizationId },
    include: {
      vehicles: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
      invoices: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceType: true,
          status: true,
          issueDate: true,
          totalAmount: true,
        },
      },
      appointments: {
        where: {
          scheduledAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24) },
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
        include: { vehicle: { select: { plateNumber: true } } },
      },
    },
  });
  if (!customer) throw new NotFoundError('customer');

  // The jobs this customer brought in — including on vehicles they no longer
  // own. Found by the job's own customer, not through the vehicle: otherwise a
  // sold vehicle would take its history to the new owner.
  const jobCards = await prisma.jobCard.findMany({
    where: { organizationId: user.organizationId, customerId: customer.id },
    orderBy: { openedAt: 'desc' },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      openedAt: true,
      closedAt: true,
      odometerReading: true,
      customerComplaint: true,
      vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
    },
  });

  return { customer, jobCards };
}
