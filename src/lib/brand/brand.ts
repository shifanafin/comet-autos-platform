import { cache } from 'react';
import { prisma } from '@/lib/prisma';

/*
 * The app's name, taken from the workshop's own Settings — never written
 * into the code. Change "Workshop name" in Settings and the sidebar, the
 * sign-in page, tab titles, the installed app and its icon all follow.
 *
 * Signed in, it is the user's own organization. Before sign-in (the sign-in
 * page, the app manifest, the icons) there is no user yet; this is a
 * single-business deployment, so it is the business's organization — the
 * first one created. (Integration tests add throwaway organizations to the
 * same database later; they are never the first.)
 */

export interface Brand {
  /** The workshop name as entered in Settings. */
  name: string;
  /** Without a trailing legal form (LLC, FZE, …) — for titles and tight spaces. */
  shortName: string;
  /** The letter on the app icon and the sidebar tile. */
  initial: string;
  /** Safe for file names, e.g. exports. */
  filePrefix: string;
}

/** What a brand-new install shows before Settings has a name in it. */
const FALLBACK_NAME = 'Workshop';

const LEGAL_FORM =
  /[\s,.-]+(L\.?\s?L\.?\s?C\.?|F\.?\s?Z\.?\s?E\.?|F\.?\s?Z\.?\s?C\.?\s?O\.?|F\.?\s?Z\.?\s?-?\s?LLC|W\.?\s?L\.?\s?L\.?|LTD\.?|LIMITED|EST\.?|ESTABLISHMENT)$/i;

/** Derives every form of the name from the one in Settings. Pure. */
export function brandFromName(rawName: string | null | undefined): Brand {
  const name = rawName?.trim().replace(/\s+/g, ' ') || FALLBACK_NAME;
  const shortName = name.replace(LEGAL_FORM, '').trim() || name;
  const initial = (shortName.match(/[\p{L}\p{N}]/u)?.[0] ?? 'W').toUpperCase();
  const filePrefix =
    shortName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workshop';
  return { name, shortName, initial, filePrefix };
}

/**
 * The brand for an organization, or — with no organization, before sign-in —
 * for the business this deployment serves. Read once per request.
 */
export const getBrand = cache(async (organizationId?: string): Promise<Brand> => {
  const organization = organizationId
    ? await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      })
    : await prisma.organization.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { name: true },
      });
  return brandFromName(organization?.name);
});
