import { requireUser } from '@/lib/auth/authorize';
import { getLetterheadDetails } from '@/lib/documents/letterhead';
import { PageHeader, Stack } from '@/components/layout/primitives';
import { LetterheadEditor } from '@/components/documents/letterhead-editor';

export const metadata = { title: 'Letterhead' };

/** Letters on the company letterhead — agreements, notices, certificates. */
export default async function LetterheadPage() {
  const user = await requireUser();
  const details = await getLetterheadDetails(user);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <div className="letterhead-controls">
        <PageHeader
          eyebrow="Documents"
          title="Letterhead"
          description="Write a letter on the company letterhead, then print it or save it as a PDF from the print window."
        />
      </div>
      <LetterheadEditor details={details} storageKey={`org:${user.organizationId}`} />
    </Stack>
  );
}
