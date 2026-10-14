/** A vendor's name reduced to its letters and digits: "ENOC / EPPCO" → "enoceppco". */
const vendorKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Two spellings of one vendor, as the same bill gets typed twice: the same
 * once reduced ("Enoc", "ENOC."), or one holding the other ("ENOC" and
 * "ENOC / EPPCO"). Pure: the duplicate-bill checks use it.
 */
export function sameVendor(a: string, b: string) {
  const [x, y] = [vendorKey(a), vendorKey(b)];
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)));
}
