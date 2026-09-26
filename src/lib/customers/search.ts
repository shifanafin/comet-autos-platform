import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { compactPlate, phoneCore } from '@/lib/normalize';

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Matches customers and vehicles by any identifier staff actually have at
 * the counter: customer name, mobile number (any format — "050 123 4567",
 * "+971501234567"), vehicle registration (with or without spaces), or VIN.
 * Returns ids only; callers load the shape they need.
 */
export async function findMatchingIds(
  organizationId: string,
  rawQuery: string,
  limit = 50,
): Promise<{ customerIds: string[]; vehicleIds: string[] }> {
  const query = rawQuery.trim();
  if (query.length < 2) return { customerIds: [], vehicleIds: [] };

  const name = likePattern(query);
  const core = phoneCore(query);
  const phone = core.length >= 4 ? likePattern(core) : null;
  const plate = likePattern(compactPlate(query));

  const rows = await prisma.$queryRaw<
    { customer_id: string; vehicle_id: string | null }[]
  >(Prisma.sql`
    SELECT c.id AS customer_id, v.id AS vehicle_id
    FROM customers c
    LEFT JOIN vehicles v
      ON v.customer_id = c.id AND v.organization_id = c.organization_id AND v.is_active
    WHERE c.organization_id = ${organizationId}::uuid
      AND c.is_active
      AND (
        c.name ILIKE ${name}
        OR (${phone}::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE ${phone})
        OR replace(upper(v.plate_number), ' ', '') LIKE ${plate}
        OR upper(coalesce(v.vin, '')) LIKE ${plate}
      )
    ORDER BY c.name
    LIMIT ${limit * 4}
  `);

  const customerIds = [...new Set(rows.map((row) => row.customer_id))].slice(0, limit);
  const vehicleIds = [
    ...new Set(rows.map((row) => row.vehicle_id).filter((id): id is string => id !== null)),
  ].slice(0, limit);
  return { customerIds, vehicleIds };
}

/** Vehicles matching by registration / VIN, plus the vehicles of customers matched by name or mobile. */
export async function searchVehicles(organizationId: string, query: string, limit = 50) {
  const { customerIds } = await findMatchingIds(organizationId, query, limit);
  if (customerIds.length === 0) return [];
  const plate = compactPlate(query);
  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId, isActive: true, customerId: { in: customerIds } },
    include: { customer: { select: { id: true, name: true, phone: true } } },
    take: limit,
  });
  // Direct registration/VIN hits first.
  const score = (v: { plateNumber: string; vin: string | null }) =>
    compactPlate(v.plateNumber).includes(plate) || (v.vin ?? '').includes(plate) ? 0 : 1;
  return vehicles.sort((a, b) => score(a) - score(b) || a.plateNumber.localeCompare(b.plateNumber));
}

/** Registration uniqueness ignoring case and spacing ("A12345" clashes with "A 12345"). */
export async function vehiclePlateExists(
  client: Prisma.TransactionClient,
  organizationId: string,
  plateNumber: string,
  excludeVehicleId?: string,
): Promise<false | 'active' | 'deleted'> {
  const compact = compactPlate(plateNumber);
  const rows = await client.$queryRaw<{ id: string; is_active: boolean }[]>(Prisma.sql`
    SELECT id, is_active FROM vehicles
    WHERE organization_id = ${organizationId}::uuid
      AND replace(upper(plate_number), ' ', '') = ${compact}
      AND (${excludeVehicleId ?? null}::uuid IS NULL OR id <> ${excludeVehicleId ?? null}::uuid)
    ORDER BY is_active DESC
    LIMIT 1
  `);
  if (rows.length === 0) return false;
  return rows[0].is_active ? 'active' : 'deleted';
}
