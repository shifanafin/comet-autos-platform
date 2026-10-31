import { calculateLine, filsToString, toFils } from '@/lib/money';

/*
 * Typing a figure that already includes VAT. The books always keep the price
 * before VAT, with the VAT worked out on top per line (lib/money), so this
 * only converts what was typed — on screen, before it is sent. The server
 * prices and checks the result like any other figure.
 *
 * A single amount splits exactly: the VAT inside it is amount × rate ÷
 * (100 + rate), and the net is what remains. A price per unit can't always
 * come back to the fil: VAT is rounded, so a line's total skips an occasional
 * value (at 5%, a net of 10.09 gives 10.59 and 10.10 gives 10.61 — nothing
 * gives 10.60). The nearest price is used and the difference is reported, for
 * the round-off on the bill or the VAT figure typed from it.
 *
 * Plain functions, used on screen. A figure not yet valid gives null.
 */

export type PriceBasis = 'EXCLUSIVE' | 'INCLUSIVE';

/** "5", "5.00", "" (no VAT) → hundredths of a percent; null if it isn't a rate. */
function rateHundredths(rate: string): number | null {
  const text = rate.trim();
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const hundredths = Math.round(Number(text) * 100);
  return hundredths <= 10000 ? hundredths : null;
}

function readFils(amount: string): number | null {
  const text = amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  try {
    return toFils(text);
  } catch {
    return null;
  }
}

/** A total split into its net and the VAT inside it, exact to the fil. */
export function splitInclusive(amount: string, rate: string) {
  const gross = readFils(amount);
  const hundredths = rateHundredths(rate);
  if (gross === null || hundredths === null) return null;
  const vat = Math.round((gross * hundredths) / (10000 + hundredths));
  return { net: filsToString(gross - vat), vat: filsToString(vat) };
}

export interface FittedPrice {
  /** The price per unit before VAT, to send. */
  unitPrice: string;
  /** What quantity × the typed price comes to, and what the line actually does. */
  wanted: string;
  actual: string;
  /** The line comes to exactly what was typed. */
  exact: boolean;
}

/**
 * The price per unit before VAT that brings a line closest to quantity × the
 * VAT-inclusive price typed, by the same rule the line is priced with.
 */
export function fitInclusivePrice(
  inclusivePrice: string,
  quantity: string,
  rate: string,
): FittedPrice | null {
  const price = readFils(inclusivePrice);
  const hundredths = rateHundredths(rate);
  if (price === null || hundredths === null) return null;
  const rateText = (hundredths / 100).toFixed(2);
  const totalAt = (priceFils: number) => {
    const line = calculateLine({
      quantity,
      unitPrice: filsToString(priceFils),
      taxRate: rateText,
    });
    return line.lineTotalFils + line.taxFils;
  };
  try {
    const wanted = calculateLine({
      quantity,
      unitPrice: filsToString(price),
      taxRate: '0',
    }).lineTotalFils;
    const start = Math.round((price * 10000) / (10000 + hundredths));
    let best = start;
    let bestOff = Math.abs(totalAt(start) - wanted);
    for (const candidate of [start - 1, start + 1, start - 2, start + 2]) {
      if (candidate < 0) continue;
      const off = Math.abs(totalAt(candidate) - wanted);
      if (off < bestOff) {
        best = candidate;
        bestOff = off;
      }
    }
    return {
      unitPrice: filsToString(best),
      wanted: filsToString(wanted),
      actual: filsToString(totalAt(best)),
      exact: bestOff === 0,
    };
  } catch {
    return null;
  }
}

/** A price before VAT as the customer or the bill would see it, with its VAT. */
export function inclusiveOf(unitPrice: string, rate: string): string {
  const price = readFils(unitPrice);
  const hundredths = rateHundredths(rate);
  if (price === null || hundredths === null) return unitPrice;
  return filsToString(price + Math.round((price * hundredths) / 10000));
}
