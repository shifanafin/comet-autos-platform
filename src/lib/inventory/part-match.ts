/*
 * "Did you mean…?" — finding a part already in the catalogue under a
 * slightly different name before a second one is made.
 *
 * People type the same part many ways: "Brake pad" and "brake pads",
 * "Spark-plug" and "spark plug", "Alternater" for "Alternator", the part
 * number with or without its dashes. Each is compared squeezed — lower case,
 * letters and digits only — on its own and word by word, by how many letter
 * pairs the two share (the Dice coefficient), which forgives a plural, a
 * missing space or a typo, but not a different part.
 *
 * Plain functions, used by the screens as the name is typed and by the
 * server before a new part is saved — so both warn about the same parts.
 */

/** "Brake-Pads (Front)" → "brakepadsfront". */
export function squeeze(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '');
}

/** Words of three letters or more, squeezed: "Oil filter - Toyota" → ["oil", "filter", "toyota"]. */
function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((word) => word.length >= 3);
}

/** The one- and two-character tokens of a name, sorted: "Headlamp LH" → "lh", "Bulb H7" → "h7". */
function marks(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((word) => word.length > 0 && word.length < 3)
    .sort()
    .join(' ');
}

function pairs(text: string) {
  const list: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) list.push(text.slice(i, i + 2));
  return list;
}

/** How alike two squeezed strings are, 0 to 1, by the letter pairs they share. */
export function dice(a: string, b: string) {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const left = pairs(a);
  const right = new Map<string, number>();
  for (const pair of pairs(b)) right.set(pair, (right.get(pair) ?? 0) + 1);
  let shared = 0;
  for (const pair of left) {
    const count = right.get(pair) ?? 0;
    if (count > 0) {
      shared += 1;
      right.set(pair, count - 1);
    }
  }
  return (2 * shared) / (left.length + b.length - 1);
}

/** Each word of `a` matched to its closest word in `b`, averaged: word order and extra words matter less. */
function wordScore(a: string, b: string) {
  const left = words(a);
  const right = words(b).map(squeeze);
  if (left.length === 0 || right.length === 0) return 0;
  const best = left.map((word) => Math.max(...right.map((other) => dice(squeeze(word), other))));
  return best.reduce((sum, score) => sum + score, 0) / best.length;
}

export interface MatchCandidate {
  id: string;
  name: string;
  sku: string;
}

/** How likely `typed` names the same part as `part`, 0 to 1. */
export function partSimilarity(typed: { name: string; sku?: string }, part: MatchCandidate) {
  const sku = squeeze(typed.sku ?? '');
  if (sku.length >= 3 && sku === squeeze(part.sku)) return 1;
  const a = squeeze(typed.name);
  const b = squeeze(part.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const whole = dice(a, b);
  // LH/RH, H4/H7, A/B tell variants apart, and the word score can't see
  // them: names whose short marks differ are compared whole only.
  if (marks(typed.name) !== marks(part.name)) return whole;
  // One name inside the other: "brakepad" in "brakepads", "oilfilter" in "oilfiltertoyota".
  const contained = a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a));
  const byWord = Math.min(wordScore(typed.name, part.name), wordScore(part.name, typed.name));
  return Math.max(whole, byWord, contained ? 0.85 : 0);
}

/** Close enough to ask "did you mean…?" as it is typed. */
export const SIMILAR = 0.65;
/** Close enough that a new part is refused until it is confirmed as different. */
export const LIKELY_SAME = 0.85;

/** The catalogue parts most like what was typed, best first. */
export function similarParts<Part extends MatchCandidate>(
  typed: { name: string; sku?: string },
  parts: Part[],
  { threshold = SIMILAR, limit = 5 }: { threshold?: number; limit?: number } = {},
) {
  if (squeeze(typed.name).length < 3 && squeeze(typed.sku ?? '').length < 3) return [];
  return parts
    .map((part) => ({ part, score: partSimilarity(typed, part) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.part.name.localeCompare(b.part.name))
    .slice(0, limit);
}
