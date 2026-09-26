import { notFound } from 'next/navigation';
import { requirePermission, requireUser } from '@/lib/auth/authorize';
import { prisma } from '@/lib/prisma';
import { resolveDefaultVatRate } from '@/lib/tax';
import { getCustomerOptions, type CustomerOption } from '@/lib/customers/picker';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { NewInvoiceForm, type QuotationChoice } from './invoice-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; quotation?: string; workOrder?: string }>;
}) {
  const user = await requireUser();
  requirePermission(user, 'invoice.create', { branchId: user.primaryBranchId ?? undefined });
  const params = await searchParams;

  // Billing a job card: its customer and vehicle are already known.
  let workOrder: { id: string; customerId: string; vehicleId: string } | null = null;
  if (params.workOrder && UUID.test(params.workOrder)) {
    const job = await prisma.jobCard.findFirst({
      where: { id: params.workOrder, organizationId: user.organizationId },
      select: { id: true, branchId: true, customerId: true, vehicleId: true },
    });
    if (!job) notFound();
    requirePermission(user, 'invoice.create', { branchId: job.branchId });
    workOrder = { id: job.id, customerId: job.customerId, vehicleId: job.vehicleId };
  }

  // Billing a quotation: its customer, vehicle and job card come with it.
  let quotation: QuotationChoice | null = null;
  if (params.quotation && UUID.test(params.quotation)) {
    const estimate = await prisma.estimate.findFirst({
      where: { id: params.quotation, organizationId: user.organizationId },
      select: {
        id: true,
        estimateNumber: true,
        status: true,
        totalAmount: true,
        branchId: true,
        customerId: true,
        vehicleId: true,
        jobCardId: true,
        customer: { select: { name: true } },
        _count: { select: { items: true } },
      },
    });
    if (!estimate) notFound();
    requirePermission(user, 'invoice.create', { branchId: estimate.branchId });
    quotation = {
      id: estimate.id,
      estimateNumber: estimate.estimateNumber,
      totalAmount: estimate.totalAmount.toString(),
      lineCount: estimate._count.items,
      customerId: estimate.customerId,
      customerName: estimate.customer.name,
      vehicleId: estimate.vehicleId,
      jobCardId: estimate.jobCardId,
    };
  }

  const customerId =
    quotation?.customerId ??
    workOrder?.customerId ??
    (params.customer && UUID.test(params.customer) ? params.customer : null);
  let initialCustomer: CustomerOption | null = null;
  if (customerId) {
    [initialCustomer = null] = await getCustomerOptions(user, [customerId]);
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Invoices"
        title="New invoice"
        description={
          quotation
            ? 'Billing an approved quotation — the lines and VAT are carried across as the customer saw them.'
            : 'Bill a customer for work done. A job card is not needed — link one only if you want to.'
        }
      />
      <Panel className="w-full max-w-4xl sm:p-8">
        <NewInvoiceForm
          initialCustomer={initialCustomer}
          initialWorkOrder={workOrder}
          quotation={quotation}
          defaultVatRate={await resolveDefaultVatRate(user.organizationId)}
        />
      </Panel>
    </Stack>
  );
}
