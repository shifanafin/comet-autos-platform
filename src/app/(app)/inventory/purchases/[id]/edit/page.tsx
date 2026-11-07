import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import {
  canPayOnReceipt,
  getPurchaseForEdit,
  getPurchaseFormOptions,
} from '@/lib/inventory/purchases';
import { supplierPaidFils } from '@/lib/finance/supplier-balance';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getAccountChoices } from '@/lib/accounting/reports';
import { localDateString } from '@/lib/format';
import { filsToString, formatMilli, signedToMilli } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { PurchaseForm } from '@/components/inventory/purchase-form';
import { updatePurchaseAction } from '../../../actions';

export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let purchase;
  try {
    purchase = await getPurchaseForEdit(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const received = purchase.status === 'RECEIVED' && !purchase.billMatchedByUserId;
  if (purchase.status !== 'DRAFT' && !received) redirect(`/inventory/purchases/${purchase.id}`);
  const options = await getPurchaseFormOptions(user);
  // Nothing paid yet: it can be paid with the correction, as on receiving it.
  const paidSoFar = received ? filsToString(supplierPaidFils(purchase.supplierPayments)) : null;
  const canPay = received && paidSoFar === '0.00' && canPayOnReceipt(user);
  const [modes, accounts] = canPay
    ? await Promise.all([
        getPaymentModeOptions(user.organizationId, 'spending'),
        getAccountChoices(user),
      ])
    : [[], null];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href={`/inventory/purchases/${purchase.id}`}
            className="tracking-normal normal-case hover:text-foreground"
          >
            {purchase.purchaseNumber}
          </Link>
        }
        title={received ? 'Edit purchase' : 'Edit draft purchase'}
        description={
          received
            ? "Stock, VAT and what is owed are corrected to match, and the part's cost price with them. Parts already used keep the cost they were charged at. Refused once its period is closed or its VAT return is filed."
            : undefined
        }
      />
      <Panel className="w-full sm:p-8">
        <PurchaseForm
          action={updatePurchaseAction.bind(null, purchase.id)}
          parts={options.parts}
          canCreateParts={options.canCreateParts}
          suppliers={options.suppliers}
          defaultVat={options.defaultVat}
          taxCodes={options.taxCodes}
          jobs={options.jobs}
          receivedOn={received && purchase.receivedAt ? localDateString(purchase.receivedAt) : null}
          paidSoFar={paidSoFar}
          receipt={
            canPay
              ? { modes, moneyAccounts: accounts?.money ?? [], canPay, canUpdateCost: false }
              : undefined
          }
          today={localDateString()}
          initial={{
            supplierId: purchase.supplierId,
            supplierInvoiceNumber: purchase.supplierInvoiceNumber ?? '',
            supplierInvoiceDate: purchase.supplierInvoiceDate
              ? purchase.supplierInvoiceDate.toISOString().slice(0, 10)
              : '',
            notes: purchase.notes ?? '',
            billDiscountType: purchase.billDiscountType,
            billDiscountValue: purchase.billDiscountValue?.toString() ?? '',
            roundingAdjustment: purchase.roundingAdjustment.isZero()
              ? ''
              : purchase.roundingAdjustment.toFixed(2),
            dueDate: purchase.dueDate ? purchase.dueDate.toISOString().slice(0, 10) : '',
            items: purchase.items.map((item) => ({
              partId: item.partId,
              quantity: formatMilli(signedToMilli(item.quantityOrdered)),
              unitCost: item.unitCost.toFixed(2),
              taxRate: item.taxRate?.toString() ?? options.defaultVat,
              taxCodeId: item.taxCodeId,
              jobCardId: item.jobCardId ?? '',
              discountType: item.discountType,
              discountValue: item.discountValue?.toString() ?? '',
            })),
          }}
          isNew={false}
          canReceive={false}
          cancelHref={`/inventory/purchases/${purchase.id}`}
        />
      </Panel>
    </Stack>
  );
}
