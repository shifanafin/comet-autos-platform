'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SIMPLE_WORKFLOW_STATUSES, WORKFLOW_STAGES } from '@/lib/workshop/stages';

/**
 * The statuses to filter by. A simple workshop sees only its own short
 * path — plus whatever status is already selected, so a link to a
 * detailed stage still reads correctly.
 */
function statusOptions(detailed: boolean, selected: string) {
  const stages = detailed
    ? WORKFLOW_STAGES
    : WORKFLOW_STAGES.filter(
        (stage) => SIMPLE_WORKFLOW_STATUSES.includes(stage.status) || stage.status === selected,
      );
  return [
    { value: '', label: 'All statuses' },
    ...stages.map((stage) => ({ value: stage.status, label: stage.label })),
    { value: 'REJECTED', label: 'Estimate rejected' },
    { value: 'ON_HOLD', label: 'On hold' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];
}

export function JobCardFilters({
  status,
  q,
  detailed,
}: {
  status: string;
  q: string;
  /** Whether the workshop uses the standard job card, with every step. */
  detailed: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(q);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (query === q) return;
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (query) params.set('q', query);
      router.push(`${pathname}?${params.toString()}`);
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function updateStatus(nextStatus: string) {
    const params = new URLSearchParams();
    if (nextStatus) params.set('status', nextStatus);
    if (query) params.set('q', query);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search job #, plate, customer"
          className="pl-9"
        />
      </div>
      <select
        value={status}
        onChange={(event) => updateStatus(event.target.value)}
        className="h-9 rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {statusOptions(detailed, status).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
