'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, User, Car, ClipboardList } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { globalSearch, type GlobalSearchResults } from '@/lib/search';

const EMPTY: GlobalSearchResults = { customers: [], vehicles: [], jobCards: [] };

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Base UI's Dialog moves focus on open; defer so our own autofocus wins.
    const timeout = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [open]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= 2;

  useEffect(() => {
    if (!hasQuery) return;
    const timeout = setTimeout(() => {
      globalSearch(trimmed)
        .then(setResults)
        .catch(() => setResults(EMPTY));
    }, 200);
    return () => clearTimeout(timeout);
  }, [trimmed, hasQuery]);

  const displayedResults = hasQuery ? results : EMPTY;

  function go(href: string) {
    setOpen(false);
    setQuery('');
    router.push(href);
  }

  const hasResults =
    displayedResults.customers.length +
      displayedResults.vehicles.length +
      displayedResults.jobCards.length >
    0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:border-ring/50"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">Search customers, vehicles, jobs…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="top-[20%] max-w-lg translate-y-0 gap-0 p-0"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Vehicle number, mobile, customer name, or job number"
              className="border-none px-0 shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="max-h-80 overflow-y-auto p-2">
            {trimmed.length < 2 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Start typing to search across customers, vehicles, and job cards.
              </p>
            ) : !hasResults ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No matches for &ldquo;{trimmed}&rdquo;.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {displayedResults.jobCards.length > 0 ? (
                  <ResultGroup label="Job cards">
                    {displayedResults.jobCards.map((jc) => (
                      <ResultRow
                        key={jc.id}
                        icon={<ClipboardList className="size-4" />}
                        title={jc.jobNumber}
                        subtitle={`${jc.plateNumber} · ${jc.customerName}`}
                        extra={<JobStatusBadge status={jc.status} />}
                        onClick={() => go(`/job-cards/${jc.id}`)}
                      />
                    ))}
                  </ResultGroup>
                ) : null}

                {displayedResults.vehicles.length > 0 ? (
                  <ResultGroup label="Vehicles">
                    {displayedResults.vehicles.map((v) => (
                      <ResultRow
                        key={v.id}
                        icon={<Car className="size-4" />}
                        title={`${v.plateNumber} — ${v.make} ${v.model}`}
                        subtitle={v.customerName}
                        onClick={() => go(`/vehicles/${v.id}`)}
                      />
                    ))}
                  </ResultGroup>
                ) : null}

                {displayedResults.customers.length > 0 ? (
                  <ResultGroup label="Customers">
                    {displayedResults.customers.map((c) => (
                      <ResultRow
                        key={c.id}
                        icon={<User className="size-4" />}
                        title={c.name}
                        subtitle={c.phone}
                        onClick={() => go(`/customers/${c.id}`)}
                      />
                    ))}
                  </ResultGroup>
                ) : null}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResultGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ResultRow({
  icon,
  title,
  subtitle,
  extra,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  extra?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left enabled:hover:bg-muted disabled:opacity-60"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
      {extra}
    </button>
  );
}
