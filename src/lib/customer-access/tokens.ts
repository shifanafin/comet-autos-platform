import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { CustomerAccessResourceType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';

/*
 * Customer secure access (CustomerAccessToken):
 *
 * - One token = one resource (here: one Estimate version). Never a login.
 * - The raw token is 256 bits of randomness and exists only in the link
 *   given to the customer; the database stores its SHA-256 hash.
 * - Holding the link is what opens the document — the customer taps it in
 *   WhatsApp and sees it, with nothing to type. That is only safe because
 *   the link can't be guessed or reused for anything else.
 * - Tokens expire, are revoked when a newer estimate version supersedes the
 *   one they point at, and every decision re-checks the link.
 */

const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function issueAccessToken(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    resourceType: CustomerAccessResourceType;
    resourceId: string;
    createdByUserId: string;
    expiresAt: Date;
  },
): Promise<{ rawToken: string; tokenId: string }> {
  const rawToken = generateRawToken();
  const token = await tx.customerAccessToken.create({
    data: {
      organizationId: params.organizationId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      tokenHash: hashToken(rawToken),
      expiresAt: params.expiresAt,
      createdByUserId: params.createdByUserId,
    },
  });
  return { rawToken, tokenId: token.id };
}

export async function revokeAccessTokens(
  tx: Prisma.TransactionClient,
  organizationId: string,
  resourceType: CustomerAccessResourceType,
  resourceIds: string[],
): Promise<number> {
  if (resourceIds.length === 0) return 0;
  const result = await tx.customerAccessToken.updateMany({
    where: { organizationId, resourceType, resourceId: { in: resourceIds }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export type TokenState = 'valid' | 'expired' | 'invalid';

export interface ResolvedToken {
  state: TokenState;
  token: {
    id: string;
    organizationId: string;
    resourceType: CustomerAccessResourceType;
    resourceId: string;
    tokenHash: string;
    createdByUserId: string;
    expiresAt: Date;
  } | null;
}

/**
 * Looks a raw token up. Malformed, unknown and revoked tokens are all
 * reported as "invalid" — the customer page never reveals which.
 */
export async function resolveAccessToken(
  rawToken: string,
  expectedType: CustomerAccessResourceType,
  client: Prisma.TransactionClient = prisma,
): Promise<ResolvedToken> {
  if (!RAW_TOKEN_PATTERN.test(rawToken)) return { state: 'invalid', token: null };
  const token = await client.customerAccessToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!token || token.revokedAt || token.resourceType !== expectedType) {
    return { state: 'invalid', token: null };
  }
  if (token.expiresAt.getTime() <= Date.now()) return { state: 'expired', token };
  return { state: 'valid', token };
}
