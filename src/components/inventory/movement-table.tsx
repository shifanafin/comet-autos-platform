import Link from 'next/link';
import type { InventoryTransactionType } from '@/generated/prisma/enums';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReverseMovementButton } from '@/components/inventory/stock-actions';
import { SelectCell, SelectHead } from '@/components/shared/record-selection';
import { MOVEMENT_LABEL } from '@/lib/inventory/labels';
import { formatDateTime } from '@/lib/format';
import { formatMilli } from '@/lib/money';
import { cn } from '@/lib/utils';

const TONE: Record<InventoryTransactionType, PillTone> = {
  OPENING_STOCK: 'info',
  PURCHASE_RECEIPT: 'success',
  JOB_CONSUMPTION: 'primary',
  JOB_RETURN: 'info',
  ADJUSTMENT: 'neutral',
  REVERSAL: 'warning',
  TRANSFER_IN: 'neutral',
  TRANSFER_OUT: 'neutral',
  RETURN_TO_SUPPLIER: 'neutral',
  CUSTOMER_RETURN: 'neutral',
};

export interface MovementRow {
  id: string;
  transactionType: InventoryTransactionType;
  quantityMilli: number;
  balanceMilli?: number;
  note: string | null;
  createdAt: Date;
  performedBy: { fullName: string } | null;
  partUsage: { jobCard: { id: string; jobNumber: string } } | null;
  purchaseItem: {
    purchase: { id: string; purchaseNumber: string; supplier: { name: string } };
  } | null;
  reversedBy: { id: string; createdAt: Date } | null;
  reversalOf: { id: string; transactionType: InventoryTransactionType } | null;
  reversible?: boolean;
  part?: { id: string; sku: string; name: string; unitOfMeasure: string };
}

function Reference({ movement }: { movement: MovementRow }) {
  if (movement.partUsage) {
    return (
      <Link
        href={`/job-cards/${movement.partUsage.jobCard.id}`}
        className="font-medium text-primary hover:underline"
      >
        {movement.partUsage.jobCard.jobNumber}
      </Link>
    );
  }
  if (movement.purchaseItem) {
    const { purchase } = movement.purchaseItem;
    return (
      <span className="flex flex-col">
        <Link
          href={`/inventory/purchases/${purchase.id}`}
          className="font-medium text-primary hover:underline"
        >
          {purchase.purchaseNumber}
        </Link>
        <span className="text-xs text-muted-foreground">{purchase.supplier.name}</span>
      </span>
    );
  }
  if (movement.reversalOf)
    return (
      <span className="text-muted-foreground">
        Reverses {MOVEMENT_LABEL[movement.reversalOf.transactionType].toLowerCase()}
      </span>
    );
  return <span className="text-muted-foreground">—</span>;
}

/**
 * The stock ledger as a table: every movement with its direction, the
 * running balance (on a part's own history), what it relates to, who made
 * it and why. Adjustments and opening stock can be reversed from here.
 */
export function MovementTable({
  movements,
  showPart = false,
  showBalance = false,
  unit,
  canReverse = false,
  selectable = false,
}: {
  movements: MovementRow[];
  showPart?: boolean;
  showBalance?: boolean;
  unit?: string;
  canReverse?: boolean;
  /** Tick boxes for reversing several at once; needs a surrounding <RecordSelection>. */
  selectable?: boolean;
}) {
  const labelOf = (movement: MovementRow) =>
    `${MOVEMENT_LABEL[movement.transactionType]}${movement.part ? ` · ${movement.part.name}` : ''}`;
  const reversibleRows = movements
    .filter((movement) => movement.reversible)
    .map((movement) => ({ id: movement.id, label: labelOf(movement) }));
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            {selectable ? <SelectHead rows={reversibleRows} /> : null}
            <TableHead>When</TableHead>
            {showPart ? <TableHead>Part</TableHead> : null}
            <TableHead>Movement</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            {showBalance ? <TableHead className="text-right">Balance</TableHead> : null}
            <TableHead>Reference</TableHead>
            <TableHead className="min-w-56">Reason / note</TableHead>
            <TableHead>By</TableHead>
            {canReverse ? <TableHead className="w-0" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {movements.map((movement) => (
            <TableRow
              key={movement.id}
              className={cn(movement.reversedBy && 'text-muted-foreground')}
            >
              {selectable ? (
                <SelectCell
                  id={movement.id}
                  label={labelOf(movement)}
                  removable={Boolean(movement.reversible)}
                />
              ) : null}
              <TableCell className="whitespace-nowrap tabular-nums">
                {formatDateTime(movement.createdAt)}
              </TableCell>
              {showPart && movement.part ? (
                <TableCell>
                  <Link
                    href={`/inventory/parts/${movement.part.id}`}
                    className="font-medium hover:underline"
                  >
                    {movement.part.name}
                  </Link>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {movement.part.sku}
                  </span>
                </TableCell>
              ) : null}
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <StatusPill tone={TONE[movement.transactionType]}>
                    {MOVEMENT_LABEL[movement.transactionType]}
                  </StatusPill>
                  {movement.reversedBy ? (
                    <span className="text-xs">
                      Reversed {formatDateTime(movement.reversedBy.createdAt)}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-semibold whitespace-nowrap tabular-nums',
                  movement.quantityMilli > 0 ? 'text-success' : 'text-foreground',
                  movement.reversedBy && 'line-through decoration-muted-foreground/60',
                )}
              >
                {movement.quantityMilli > 0 ? '+' : '−'}
                {formatMilli(Math.abs(movement.quantityMilli))}
                {unit ?? (movement.part ? ` ${movement.part.unitOfMeasure}` : '')}
              </TableCell>
              {showBalance ? (
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatMilli(movement.balanceMilli ?? 0)}
                </TableCell>
              ) : null}
              <TableCell>
                <Reference movement={movement} />
              </TableCell>
              <TableCell className="text-sm">{movement.note ?? '—'}</TableCell>
              <TableCell className="whitespace-nowrap">
                {movement.performedBy?.fullName ?? '—'}
              </TableCell>
              {canReverse ? (
                <TableCell className="text-right">
                  {movement.reversible ? (
                    <ReverseMovementButton
                      transactionId={movement.id}
                      quantity={movement.quantityMilli}
                    />
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
