import Link from 'next/link';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { canPayOnReceipt, getPurchaseFormOptions } from '@/lib/inventory/purchases';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getAccountChoices } from '@/lib/accounting/reports';
import { localDateString } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ScanPurchase } from '@/components/inventory/scan-purchase';
import { createPurchaseAction } from '../../actions';

export default async function NewPurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ supplier?: string }>;
}) {
  const user = await requireUser();
  const { supplier } = await searchParams;
  const options = await getPurchaseFormOptions(user);
  const canPay = canPayOnReceipt(user);
  const [modes, accounts] = canPay
    ? await Promise.all([
        getPaymentModeOptions(user.organizationId, 'spending'),
        getAccountChoices(user),
      ])
    : [[], null];
  const preselected = options.suppliers.some((s) => s.id === supplier) ? supplier! : '';

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href="/inventory/purchases"
            className="tracking-normal normal-case hover:text-foreground"
          >
            Purchases
          </Link>
        }
        title="New purchase"
        description="Enter the supplier invoice, or scan it. Receive it now if the parts arrived with it, or save a draft and receive later."
      />
      <Panel className="w-full sm:p-8">
        <ScanPurchase
          action={createPurchaseAction}
          parts={options.parts}
          canCreateParts={options.canCreateParts}
          suppliers={options.suppliers}
          defaultVat={options.defaultVat}
          taxCodes={options.taxCodes}
          jobs={options.jobs}
          today={localDateString()}
          initial={
            preselected
              ? {
                  supplierId: preselected,
                  supplierInvoiceNumber: '',
                  supplierInvoiceDate: localDateString(),
                  notes: '',
                  items: [],
                }
              : undefined
          }
          canReceive={hasPermission(user, 'purchase.approve')}
          cancelHref="/inventory/purchases"
          receipt={{
            modes,
            moneyAccounts: accounts?.money ?? [],
            canPay,
            canUpdateCost: hasPermission(user, 'inventory.create'),
          }}
        />
      </Panel>
    </Stack>
  );
}
