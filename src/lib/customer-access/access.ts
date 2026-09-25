import type { CustomerAccessResourceType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { resolveAccessToken } from '@/lib/customer-access/tokens';

/*
 * The customer-link check shared by every customer page (quotation,
 * invoice): the link opens the document by itself — the customer taps it in
 * WhatsApp and sees their quotation, nothing to type. What keeps it private
 * is the link: 256 random bits, one document per link, stored only as a
 * hash, expiring, and revoked when a quotation is revised. Nothing here
 * takes an internal id from the browser — only the raw token from the URL.
 */

export interface OrganizationBranding {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
}

export type CustomerAccess =
  | { state: 'invalid' }
  | { state: 'expired'; organization: OrganizationBranding }
  | {
      state: 'open';
      tokenHash: string;
      organization: OrganizationBranding;
      organizationId: string;
      resourceId: string;
    };

export async function loadBranding(organizationId: string): Promise<OrganizationBranding> {
  return prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      name: true,
      legalName: true,
      address: true,
      phone: true,
      email: true,
      taxNumber: true,
    },
  });
}

/** Resolves the link: open for a live link of the expected kind, otherwise why not. */
export async function getCustomerAccess(
  rawToken: string,
  type: CustomerAccessResourceType,
): Promise<CustomerAccess> {
  const resolved = await resolveAccessToken(rawToken, type);
  if (resolved.state === 'invalid' || !resolved.token) return { state: 'invalid' };
  const organization = await loadBranding(resolved.token.organizationId);
  if (resolved.state === 'expired') return { state: 'expired', organization };
  return {
    state: 'open',
    tokenHash: resolved.token.tokenHash,
    organization,
    organizationId: resolved.token.organizationId,
    resourceId: resolved.token.resourceId,
  };
}
