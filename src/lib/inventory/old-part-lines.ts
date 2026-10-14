import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { formatMilli, multiplyQuantity, signedToMilli } from '@/lib/money';
import { syncPosting } from '@/lib/accounting/journal';
import { syncInvoiceStock } from '@/lib/inventory/invoice-stock';
import { getStockByPart } from '@/lib/inventory/stock';
import { partSimilarity } from '@/lib/inventory/part-match';
import { assertNotFitted, partsFittedOnJob, resolvePartLines } from '@/lib/billing/part-lines';
import { isCredited } from '@/lib/billing/invoice-changes';

/*
 * Parts lines from before parts were tied to stock.
 *
 * An invoice issued then could bill a part by name alone: no catalogue part,
 * no cost. Its stock was never taken out for it, and the job's profit shows
 * the whole price as profit. Each such line is settled here, once, in one of
 * three ways — whichever is true of it:
 *
 *   Already written off   The part left stock on a write-off of its own (an
 *                         ADJUSTMENT out — on 6 Oct 2026, "historical
 *                         consumption"), booked to cost when it was made.
 *                         The line is tied to that movement (cost_movement_
 *                         id) and costed at it: nothing more leaves stock,
 *                         no second cost is booked — the books already have
 *                         it. Only the job's profit changes.
 *   Take it out now       The part is still on the shelf in the records.
 *                         The line names it, as any Parts line does today:
 *                         its stock leaves (a SALE) and its cost is booked
 *                         on the invoice's own entry, on the invoice's date.
 *   It was work           Typed as Parts but it was labour or a service
 *                         ("Injector cleaning"). It becomes a Labour line:
 *                         the invoice's entry moves the income from parts
 *                         sales to labour sales. Its total and VAT stay.
 *
 * A line tied to a write-off can be untied again (it goes back on the list).
 * A write-off can cost no more of its part than it took out.
 */

type Tx = Prisma.TransactionClient;

/** Close enough to put a write-off at the top of a line's list. */
const LIKELY = 0.55;

/** A tax invoice that stands: issued, part-paid or paid. */
const LIVE_INVOICE = {
  invoiceType: 'TAX_INVOICE' as const,
  status: { notIn: ['DRAFT' as const, 'VOID' as const, 'CANCELLED' as const] },
};

/** A Parts line on one, still with no part and no cost. */
const OPEN_LINE = { itemType: 'PART' as const, partId: null, partUsageId: null, invoice: LIVE_INVOICE };

/**
 * Stock written off out of stock and still standing, with its cost in the
 * books: an ADJUSTMENT out, not reversed, not opening stock, with a standing
 * entry of its own. With what is left of it to cost old lines at.
 */
async function writeOffs(client: Tx | typeof prisma, organizationId: string) {
  const movements = await client.inventoryTransaction.findMany({
    where: {
      organizationId,
      transactionType: 'ADJUSTMENT',
      quantity: { lt: 0 },
      unitCost: { not: null },
      invoiceId: null,
      reversedBy: { is: null },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      branchId: true,
      quantity: true,
      unitCost: true,
      note: true,
      createdAt: true,
      part: { select: { id: true, name: true, sku: true } },
      costedLines: {
        where: { invoice: LIVE_INVOICE },
        select: { id: true, quantity: true },
      },
    },
  });
  const booked = new Set(
    (
      await client.journalEntry.findMany({
        where: {
          organizationId,
          sourceType: 'STOCK_MOVEMENT',
          sourceId: { in: movements.map((movement) => movement.id) },
          reversalOfJournalEntryId: null,
          reversals: { none: {} },
        },
        select: { sourceId: true },
      })
    ).map((entry) => entry.sourceId),
  );
  return movements
    .filter((movement) => booked.has(movement.id) && !/^opening stock/i.test(movement.note ?? ''))
    .map((movement) => {
      const outMilli = -signedToMilli(movement.quantity);
      const usedMilli = movement.costedLines.reduce(
        (sum, line) => sum + signedToMilli(line.quantity),
        0,
      );
      return {
        id: movement.id,
        branchId: movement.branchId,
        part: movement.part,
        unitCost: movement.unitCost!.toString(),
        note: movement.note,
        date: movement.createdAt,
        outMilli,
        leftMilli: outMilli - usedMilli,
      };
    });
}

export type WriteOff = Awaited<ReturnType<typeof writeOffs>>[number];

/** Everything the Old parts lines screen shows. */
export async function getOldPartLines(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;
  const [open, costed, offs, parts] = await Promise.all([
    prisma.invoiceItem.findMany({
      where: { organizationId, ...OPEN_LINE },
      orderBy: [{ invoice: { issueDate: 'asc' } }, { invoice: { invoiceNumber: 'asc' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        description: true,
        quantity: true,
        unitPrice: true,
        lineTotal: true,
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            issueDate: true,
            branchId: true,
            customerName: true,
            creditedAmount: true,
            customer: { select: { name: true } },
          },
        },
      },
    }),
    prisma.invoiceItem.findMany({
      where: { organizationId, costMovementId: { not: null }, invoice: LIVE_INVOICE },
      orderBy: [{ invoice: { issueDate: 'asc' } }, { invoice: { invoiceNumber: 'asc' } }],
      select: {
        id: true,
        description: true,
        quantity: true,
        unitCost: true,
        part: { select: { name: true } },
        costMovement: { select: { createdAt: true, note: true } },
        invoice: { select: { id: true, invoiceNumber: true, issueDate: true } },
      },
    }),
    writeOffs(prisma, organizationId),
    prisma.part.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, sku: true, defaultCostPrice: true },
    }),
  ]);

  // Parts on the shelf, per branch, for "take it out now".
  const branches = [...new Set(open.map((line) => line.invoice.branchId))];
  const stock = new Map(
    await Promise.all(
      branches.map(async (branchId) => [branchId, await getStockByPart(organizationId, branchId)] as const),
    ),
  );

  return {
    open: open.map((line) => {
      const quantityMilli = signedToMilli(line.quantity);
      // The write-offs most like this line first: a note naming its invoice,
      // then by how alike the part's name is to what was typed.
      const ranked = offs
        .filter((off) => off.branchId === line.invoice.branchId && off.leftMilli >= quantityMilli)
        .map((off) => ({
          id: off.id,
          score: off.note?.includes(line.invoice.invoiceNumber)
            ? 2
            : partSimilarity({ name: line.description }, off.part),
        }))
        .sort((a, b) => b.score - a.score);
      const onShelf = stock.get(line.invoice.branchId) ?? new Map<string, number>();
      return {
        id: line.id,
        description: line.description,
        quantity: formatMilli(quantityMilli),
        unitPrice: line.unitPrice.toString(),
        lineTotal: line.lineTotal.toString(),
        invoiceId: line.invoice.id,
        invoiceNumber: line.invoice.invoiceNumber,
        issueDate: line.invoice.issueDate,
        customerName: line.invoice.customerName ?? line.invoice.customer.name,
        /** Why it can't be re-booked (take out now, or work); null when it can. */
        rebookBlocker: isCredited(line.invoice)
          ? 'A credit note was issued against this invoice, so its lines stand as issued.'
          : null,
        likely: ranked.filter((entry) => entry.score >= LIKELY).map((entry) => entry.id),
        others: ranked.filter((entry) => entry.score < LIKELY).map((entry) => entry.id),
        inStock: parts
          .filter((part) => (onShelf.get(part.id) ?? 0) >= quantityMilli && part.defaultCostPrice)
          .map((part) => ({
            id: part.id,
            name: part.name,
            sku: part.sku,
            onHand: formatMilli(onShelf.get(part.id) ?? 0),
            unitCost: part.defaultCostPrice!.toString(),
          })),
      };
    }),
    costed: costed.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: formatMilli(signedToMilli(line.quantity)),
      partName: line.part?.name ?? '',
      costFils: line.unitCost ? multiplyQuantity(line.quantity.toString(), line.unitCost.toString()) : 0,
      writtenOffOn: line.costMovement?.createdAt ?? null,
      writeOffNote: line.costMovement?.note ?? null,
      invoiceId: line.invoice.id,
      invoiceNumber: line.invoice.invoiceNumber,
      issueDate: line.invoice.issueDate,
    })),
    writeOffs: Object.fromEntries(
      offs.map((off) => [
        off.id,
        {
          partName: off.part.name,
          sku: off.part.sku,
          unitCost: off.unitCost,
          left: formatMilli(off.leftMilli),
          note: off.note,
          date: off.date,
        },
      ]),
    ),
  };
}

export type OldPartLines = Awaited<ReturnType<typeof getOldPartLines>>;

// ─── Settling a line ────────────────────────────────────────────────────────

/** Locks the line's invoice (its job card first, as every invoice change does) and reads the line. */
async function lockLine(tx: Tx, user: AuthenticatedUser, itemId: string) {
  const target = await tx.invoiceItem.findFirst({
    where: { id: itemId, organizationId: user.organizationId },
    select: { invoiceId: true, invoice: { select: { jobCardId: true } } },
  });
  if (!target) throw new NotFoundError('invoice line');
  if (target.invoice.jobCardId) {
    await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${target.invoice.jobCardId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
  }
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.invoiceId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
  const line = await tx.invoiceItem.findFirstOrThrow({
    where: { id: itemId, organizationId: user.organizationId },
    include: {
      account: { select: { role: true } },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          invoiceType: true,
          status: true,
          branchId: true,
          jobCardId: true,
          creditedAmount: true,
        },
      },
    },
  });
  requirePermission(user, 'accounting.view');
  requirePermission(user, 'invoice.edit', { branchId: line.invoice.branchId });
  const live =
    line.invoice.invoiceType === 'TAX_INVOICE' &&
    !['DRAFT', 'VOID', 'CANCELLED'].includes(line.invoice.status);
  if (!live) throw new DomainError('This invoice is no longer standing.');
  return line;
}

type LockedLine = Awaited<ReturnType<typeof lockLine>>;

/** Still a Parts line with no part and no cost — the kind this screen settles. */
function assertOpen(line: LockedLine) {
  if (line.itemType !== 'PART' || line.partId || line.partUsageId) {
    throw new DomainError(`“${line.description}” on ${line.invoice.invoiceNumber} is already settled.`);
  }
}

function assertRebookable(line: LockedLine) {
  if (isCredited(line.invoice)) {
    throw new DomainError(
      `A credit note was issued against ${line.invoice.invoiceNumber}, so its lines stand as issued. If its part was written off, tie the line to that instead.`,
    );
  }
}

const lineSnapshot = (line: {
  itemType: string | null;
  partId: string | null;
  unitCost: { toString(): string } | null;
  costMovementId: string | null;
}) => ({
  itemType: line.itemType,
  partId: line.partId,
  unitCost: line.unitCost?.toString() ?? null,
  costMovementId: line.costMovementId,
});

async function settled(
  tx: Tx,
  user: AuthenticatedUser,
  line: LockedLine,
  after: Parameters<typeof lineSnapshot>[0],
  how: string,
  rawInput: unknown,
) {
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: line.invoice.branchId,
    actorUserId: user.id,
    action: 'invoice.old_part_line_settled',
    entityType: 'Invoice',
    entityId: line.invoice.id,
    beforeData: lineSnapshot(line),
    afterData: lineSnapshot(after),
    metadata: { invoiceNumber: line.invoice.invoiceNumber, line: line.description, how },
  });
  await settleRequestKey(tx, user, rawInput, line.invoice.id);
  return { invoiceId: line.invoice.id, invoiceNumber: line.invoice.invoiceNumber };
}

const writeOffSchema = z.object({
  itemId: z.uuid(),
  movementId: z.uuid({ error: 'Choose the write-off its part left stock on.' }),
  requestKey: z.string().optional(),
});

/** Costs an old line at the write-off its part already left stock on. Books nothing new. */
export async function costFromWriteOff(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(writeOffSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.old_part_line');
    const line = await lockLine(tx, user, input.itemId);
    assertOpen(line);
    // Two lines may be tied to one write-off at once: lock it, then count.
    await tx.$executeRaw`SELECT id FROM inventory_transactions WHERE id = ${input.movementId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const off = (await writeOffs(tx, user.organizationId)).find((entry) => entry.id === input.movementId);
    if (!off || off.branchId !== line.invoice.branchId) {
      throw new DomainError('That write-off can’t cost this line. Choose another.', 'movementId');
    }
    const need = signedToMilli(line.quantity);
    if (off.leftMilli < need) {
      throw new DomainError(
        `That write-off of “${off.part.name}” has ${formatMilli(Math.max(off.leftMilli, 0))} left to cost lines at; this line is for ${formatMilli(need)}.`,
        'movementId',
      );
    }
    const after = await tx.invoiceItem.update({
      where: { id: line.id },
      data: { partId: off.part.id, unitCost: off.unitCost, costMovementId: off.id },
    });
    // Nothing should move: the line takes no stock and books no cost. Run
    // the rules anyway, so stock and books are proved to agree with it.
    await syncInvoiceStock(tx, { organizationId: user.organizationId, invoiceId: line.invoice.id, userId: user.id });
    await syncPosting(tx, user.organizationId, 'INVOICE', line.invoice.id, user.id);
    return settled(tx, user, line, after, `Costed at the write-off of ${off.part.name}`, rawInput);
  });
}

const stockSchema = z.object({
  itemId: z.uuid(),
  partId: z.uuid({ error: 'Choose the part it was.' }),
  requestKey: z.string().optional(),
});

/** Names the part an old line sold, taking it out of stock now and booking its cost on the invoice. */
export async function takeFromStockNow(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(stockSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.old_part_line');
    const line = await lockLine(tx, user, input.itemId);
    assertOpen(line);
    assertRebookable(line);
    // Priced and checked as a Parts line typed today: the part's cost.
    const typed: { itemType: string; description: string; partId: string; unitCost: string | null } = {
      itemType: 'PART',
      description: line.description,
      partId: input.partId,
      unitCost: null,
    };
    const [resolved] = await resolvePartLines(tx, user.organizationId, [typed], {
      required: () => true,
    });
    assertNotFitted([resolved], await partsFittedOnJob(tx, user.organizationId, line.invoice.jobCardId));
    const after = await tx.invoiceItem.update({
      where: { id: line.id },
      data: { partId: resolved.partId, unitCost: resolved.unitCost },
    });
    // Out of stock (refused if it isn't there), and costed on the invoice's entry.
    await syncInvoiceStock(tx, { organizationId: user.organizationId, invoiceId: line.invoice.id, userId: user.id });
    await syncPosting(tx, user.organizationId, 'INVOICE', line.invoice.id, user.id);
    return settled(tx, user, line, after, 'Taken out of stock', rawInput);
  });
}

const lineSchema = z.object({ itemId: z.uuid(), requestKey: z.string().optional() });

/** An old Parts line that was really labour or a service: it becomes a Labour line. */
export async function markAsWork(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(lineSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.old_part_line');
    const line = await lockLine(tx, user, input.itemId);
    assertOpen(line);
    assertRebookable(line);
    const after = await tx.invoiceItem.update({
      where: { id: line.id },
      data: {
        itemType: 'LABOUR',
        // Booked to parts sales by choice: it now books as labour, its type's default.
        ...(line.account?.role === 'SALES_PARTS' ? { accountId: null } : {}),
      },
    });
    // The income moves from parts sales to labour sales, on the invoice's date.
    await syncPosting(tx, user.organizationId, 'INVOICE', line.invoice.id, user.id);
    return settled(tx, user, line, after, 'Labour, not a part', rawInput);
  });
}

/** Unties a line from the write-off it was costed at: it goes back on the list. */
export async function undoWriteOffCost(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(lineSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.old_part_line');
    const line = await lockLine(tx, user, input.itemId);
    if (!line.costMovementId) {
      throw new DomainError(`“${line.description}” is not costed at a write-off.`);
    }
    const after = await tx.invoiceItem.update({
      where: { id: line.id },
      data: { partId: null, unitCost: null, costMovementId: null },
    });
    await syncInvoiceStock(tx, { organizationId: user.organizationId, invoiceId: line.invoice.id, userId: user.id });
    await syncPosting(tx, user.organizationId, 'INVOICE', line.invoice.id, user.id);
    return settled(tx, user, line, after, 'Untied from its write-off', rawInput);
  });
}
