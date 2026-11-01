import { filsToString, milliToString, toFils, toMilli } from '@/lib/money';

/*
 * Things bought by the can and used by the litre or kg. Stock is kept in the
 * small unit, so a can is its size in stock at a price per unit — which, kept
 * to the fil, doesn't always add back to the bill (3 kg at 63.49 is 190.47, not
 * 190.48). Plain functions, used on screen and on the server.
 */

/** The price of one unit of a pack, to the fil. Null until both figures are valid. */
export function pricePerUnit(packPrice: string, size: string): string | null {
  try {
    const milli = toMilli(size);
    if (milli <= 0) return null;
    return filsToString(Math.round((toFils(packPrice) * 1000) / milli));
  } catch {
    return null;
  }
}

/** The bill's total for `packs` at `packPrice` each, and the quantity it comes to. */
export function packTotals(packs: string, size: string, packPrice: string) {
  try {
    const packsMilli = toMilli(packs);
    const sizeMilli = toMilli(size);
    const priceFils = toFils(packPrice);
    if (packsMilli <= 0 || sizeMilli <= 0 || priceFils <= 0) return null;
    return {
      total: filsToString(Math.round((packsMilli * priceFils) / 1000)),
      quantity: milliToString(Math.round((packsMilli * sizeMilli) / 1000)),
    };
  } catch {
    return null;
  }
}

export interface PackLine {
  quantity: string;
  unitCost: string;
  /** AED off the line that brings it to the bill exactly; "" when none is needed. */
  discount: string;
}

/**
 * A purchase line for `packs` packs of `size` units at `packPrice` each. The
 * unit cost is rounded up and the few fils over taken off as a line discount:
 * a discounted line is valued at its total (lib/inventory/purchase-value.ts),
 * so the stock is worth exactly what the bill says.
 */
export function packToLine(packs: string, size: string, packPrice: string): PackLine | null {
  try {
    const packsMilli = toMilli(packs);
    const sizeMilli = toMilli(size);
    const priceFils = toFils(packPrice);
    if (packsMilli <= 0 || sizeMilli <= 0 || priceFils <= 0) return null;
    const totalFils = Math.round((packsMilli * priceFils) / 1000);
    const quantityMilli = Math.round((packsMilli * sizeMilli) / 1000);
    if (quantityMilli <= 0) return null;
    const unitFils = Math.ceil((totalFils * 1000) / quantityMilli);
    const grossFils = Math.round((quantityMilli * unitFils) / 1000);
    const offFils = grossFils - totalFils;
    return {
      quantity: milliToString(quantityMilli),
      unitCost: filsToString(unitFils),
      discount: offFils > 0 ? filsToString(offFils) : '',
    };
  } catch {
    return null;
  }
}
