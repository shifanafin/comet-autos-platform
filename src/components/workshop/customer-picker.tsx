'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Car, ClipboardList, Loader2, Search, UserPlus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { searchCustomersAction } from '@/app/(app)/customers/search-action';
import type { CustomerOption, PickerVehicle } from '@/lib/customers/picker';
import { cn } from '@/lib/utils';

/*
 * Who a document is for. The customer is the one thing every quotation and
 * invoice needs; the vehicle and the job card are offered beside it and
 * can be left alone. Everything is a large tap target, because this is the
 * first thing the owner does on his phone.
 */

export interface PickedParty {
  customer: CustomerOption;
  vehicleId: string;
  jobCardId: string;
}

export function CustomerPicker({
  value,
  onChange,
  /** Offer to file the document against one of the customer's open job cards. */
  allowJobCard = true,
  autoFocus,
}: {
  value: PickedParty | null;
  onChange: (picked: PickedParty | null) => void;
  allowJobCard?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [searchedFor, setSearchedFor] = useState('');
  const [loading, setLoading] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) return;
    const timeout = setTimeout(async () => {
      setLoading(true);
      const found = await searchCustomersAction(trimmed);
      setResults(found);
      setSearchedFor(trimmed);
      setLoading(false);
    }, 250);
    return () => clearTimeout(timeout);
  }, [trimmed]);

  if (value) {
    const { customer, vehicleId, jobCardId } = value;
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4">
          <div className="min-w-0">
            <p className="truncate font-medium">{customer.name}</p>
            <p className="truncate text-sm text-muted-foreground">{customer.phone}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => {
              onChange(null);
              setQuery('');
            }}
          >
            <X />
            Change customer
          </Button>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">
            Vehicle <span className="font-normal text-muted-foreground">— optional</span>
          </legend>
          {customer.vehicles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
              No vehicle on file for {customer.name}.{' '}
              <Link
                href={`/customers/${customer.id}/vehicles/new`}
                className="font-medium text-primary hover:underline"
              >
                Add one
              </Link>
              , or carry on without.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceButton
                selected={vehicleId === ''}
                onClick={() => onChange({ ...value, vehicleId: '', jobCardId: '' })}
                icon={<Car className="size-4 text-muted-foreground" />}
                title="No vehicle"
                subtitle="The document will not name a car"
              />
              {customer.vehicles.map((vehicle) => (
                <VehicleChoice
                  key={vehicle.id}
                  vehicle={vehicle}
                  selected={vehicleId === vehicle.id}
                  onClick={() => onChange({ ...value, vehicleId: vehicle.id })}
                />
              ))}
            </div>
          )}
          {vehicleId === '' ? (
            <p className="text-xs text-muted-foreground">
              Without a vehicle the document still saves, prints and takes payment — only the
              secure customer link needs a registration number to check against.
            </p>
          ) : null}
        </fieldset>

        {allowJobCard && customer.openJobCards.length > 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">
              Job card <span className="font-normal text-muted-foreground">— optional</span>
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceButton
                selected={jobCardId === ''}
                onClick={() => onChange({ ...value, jobCardId: '' })}
                icon={<ClipboardList className="size-4 text-muted-foreground" />}
                title="Not linked"
                subtitle="A document on its own"
              />
              {customer.openJobCards.map((job) => (
                <ChoiceButton
                  key={job.id}
                  selected={jobCardId === job.id}
                  onClick={() => onChange({ ...value, jobCardId: job.id })}
                  icon={<ClipboardList className="size-4 text-muted-foreground" />}
                  title={job.jobNumber}
                  subtitle="Open job card"
                />
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>
    );
  }

  const visible = trimmed.length >= 2 ? results : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="customer-search" className="text-sm font-medium">
          Customer name, mobile or registration
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="customer-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Ahmed, 050 123 4567 or A 12345"
            autoFocus={autoFocus}
            autoComplete="off"
            className="h-12 pl-9 text-base md:h-11 md:text-sm"
          />
          {loading ? (
            <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
      </div>

      {visible.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {visible.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    customer,
                    // One vehicle on file is almost always the right one.
                    vehicleId: customer.vehicles.length === 1 ? customer.vehicles[0].id : '',
                    jobCardId: '',
                  })
                }
                className="flex min-h-16 w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{customer.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {customer.phone}
                    {customer.vehicles.length > 0
                      ? ` · ${customer.vehicles.map((v) => v.plateNumber).join(', ')}`
                      : ' · no vehicle on file'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : trimmed.length >= 2 && !loading && searchedFor === trimmed ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No customer matches “{trimmed}”.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>A new customer?</span>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          nativeButton={false}
          render={<Link href="/customers/new" />}
        >
          <UserPlus />
          New customer
        </Button>
      </div>
    </div>
  );
}

function ChoiceButton({
  selected,
  onClick,
  icon,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
        selected ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-muted/60',
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}

function VehicleChoice({
  vehicle,
  selected,
  onClick,
}: {
  vehicle: PickerVehicle;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
        selected ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-muted/60',
      )}
    >
      <VehiclePlate plateNumber={vehicle.plateNumber} className="shrink-0 px-2 py-0.5 text-xs" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">
          {vehicle.make} {vehicle.model}
        </span>
        <span className="truncate text-xs text-muted-foreground">{vehicle.year ?? 'Year not recorded'}</span>
      </span>
    </button>
  );
}
