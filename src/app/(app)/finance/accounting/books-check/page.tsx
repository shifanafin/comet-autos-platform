import Link from 'next/link';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { PageHeader, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { BooksCheck } from '@/components/accounting/books-check';

export const metadata = { title: 'Check the books' };

/**
 * Is every transaction in the books, exactly as its record says? Every
 * record is compared with its journal entry (lib/accounting/books-check.ts).
 */
export default async function BooksCheckPage() {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.view')) return <AccessDenied what="the accounts" />;
  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/accounting" className="text-primary hover:underline">
            Accounting
          </Link>
        }
        title="Check the books"
        description="Every record that should be in the books — and is it, exactly as the record says? Anything not booked, booked differently from its record, or left behind by a record that no longer counts is listed, with a way to bring it into step."
      />
      <BooksCheck canFix={hasPermission(user, 'accounting.edit')} />
    </Stack>
  );
}
