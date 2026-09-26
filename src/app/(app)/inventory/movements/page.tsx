import Link from 'next/link';
import { History } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { listMovements, REVERSIBLE_TYPES } from '@/lib/inventory/parts';
import { MOVEMENT_LABEL } from '@/lib/inventory/labels';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { EmptyState } from '@/components/shared/empty-state';
import { ListFilters } from '@/components/inventory/list-filters';
import { MovementTable } from '@/components/inventory/movement-table';
import { RecordSelection } from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';

const TYPES = [
  'OPENING_STOCK',
  'PURCHASE_RECEIPT',
  'JOB_CONSUMPTION',
  'JOB_RETURN',
  'ADJUSTMENT',
  'REVERSAL',
] as const;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const { branch, movements } = await listMovements(user, { q: params.q, type: params.type });
  const canReverse = hasPermission(user, REMOVAL.movements.permission, { branchId: branch.id });

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href="/inventory/parts"
            className="tracking-normal normal-case hover:text-foreground"
          >
            ← Parts
          </Link>
        }
        actions={
          <ListDataActions
            entity="stock-movements"
            label="stock movements"
            search={new URLSearchParams(
              Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
            ).toString()}
          />
        }
        title="Stock movements"
        description={`Every stock change at ${branch.name}, newest first — the 200 most recent that match.`}
      />
      <Stack gap="base">
        <ListFilters
          placeholder="Part SKU, name or note"
          selects={[
            {
              name: 'type',
              label: 'Movement',
              options: [
                { value: '', label: 'All movements' },
                ...TYPES.map((t) => ({ value: t, label: MOVEMENT_LABEL[t] })),
              ],
            },
          ]}
        />
        {movements.length === 0 ? (
          <EmptyState icon={History} title="No stock movements match" />
        ) : (
          <RecordSelection entity="movements" enabled={canReverse}>
            <Panel padding="none" className="overflow-hidden">
              <MovementTable
                movements={movements.map((m) => ({
                  ...m,
                  reversible: REVERSIBLE_TYPES.includes(m.transactionType) && !m.reversedBy,
                }))}
                showPart
                canReverse={canReverse}
                selectable={canReverse}
              />
            </Panel>
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
