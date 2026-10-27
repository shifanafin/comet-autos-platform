import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getBusinessPurchasePayment } from '@/lib/finance/business-purchase';
import { getOwnerMoneyForm } from '@/lib/finance/owner-money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { BusinessPurchaseForm } from '@/components/finance/business-purchase-form';

export const metadata = { title: 'Correct a payment to buy the business' };

/** Corrects a partner's payment to buy the business — outside the company's books. */
export default async function EditBusinessPurchasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!hasPermission(user, 'money.create')) {
    return <AccessDenied what="correcting payments to buy the business" />;
  }
  let entry;
  let options;
  try {
    [entry, options] = await Promise.all([
      getBusinessPurchasePayment(user, id),
      getOwnerMoneyForm(user),
    ]);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="owner's money" />;
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/money/owner" className="text-primary hover:underline">
            Owner&apos;s money
          </Link>
        }
        title="Correct a payment to buy the business"
        description="Change what is wrong and save. It is outside the company's books, so nothing is booked; the audit log keeps what it said before."
      />
      <Panel>
        <BusinessPurchaseForm partners={options.partners} today={options.today} entry={entry} />
      </Panel>
    </Stack>
  );
}
