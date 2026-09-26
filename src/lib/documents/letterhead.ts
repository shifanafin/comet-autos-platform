import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';

/*
 * What the company letterhead prints, taken from the workshop's Settings:
 * its legal name, phone, email and address. Any signed-in user may write a
 * letter on it — these are the same details every customer document shows.
 */

export interface LetterheadDetails {
  /** The name as registered — the letterhead's headline and watermark. */
  legalName: string;
  phone: string;
  email: string;
  address: string;
}

export async function getLetterheadDetails(user: AuthenticatedUser): Promise<LetterheadDetails> {
  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { name: true, legalName: true, phone: true, email: true, address: true },
  });
  if (!organization) throw new NotFoundError('workshop');
  return {
    legalName: organization.legalName ?? organization.name,
    phone: organization.phone ?? '',
    email: organization.email ?? '',
    address: organization.address ?? '',
  };
}
