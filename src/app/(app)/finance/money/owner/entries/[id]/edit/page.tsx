import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getOwnerMoneyEntry, getOwnerMoneyForm } from '@/lib/finance/owner-money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { OwnerMoneyForm } from '@/components/finance/owner-money-form';

export const metadata = { title: "Correct owner's money" };

/** Corrects an owner's money entry where it stands; its journal entry follows. */
export default async function EditOwnerMoneyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!hasPermission(user, 'money.create')) {
    return <AccessDenied what="correcting owner's money" />;
  }
  let entry;
  let options;
  try {
    [entry, options] = await Promise.all([getOwnerMoneyEntry(user, id), getOwnerMoneyForm(user)]);
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
        title={`Correct ${entry.entryNumber}`}
        description="Change what is wrong and save: the entry and its journal entry are corrected where they stand, keeping their number. The audit log keeps what they said before."
      />
      <Panel>
        <OwnerMoneyForm options={options} entry={entry} />
      </Panel>
    </Stack>
  );
}
