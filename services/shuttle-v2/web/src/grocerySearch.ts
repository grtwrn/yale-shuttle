import type { GeocodeResult } from './format';

const normalize = (text: string) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const groceryName = (text: string) => /\b(?:trader\s*joes?|tjs?|whole\s*foods?|costco|aldi|walmart|wal mart|shop\s*rite|stop (?:and )?shop|bjs?|lidl|g mart|grocery|groceries|supermarket|market)\b/.test(text);
const groceryType = (type?: string) => /^(?:supermarket|grocery|convenience|greengrocer|wholesale|warehouse_club)$/.test(type ?? '');

/** Any Milford grocery result, not just the historic route's named endpoint. */
export function isMilfordGroceryPlace(place: GeocodeResult): boolean {
  const name = normalize(place.display_name);
  return /\bmilford\b/.test(name) && (groceryName(name) || groceryType(place.type));
}

/** Explicit searches work even when the geocoder has no matching store. */
export function isMilfordGrocerySearch(query: string, results: readonly GeocodeResult[] = []): boolean {
  const text = normalize(query);
  if (!text) return false;
  if (/\bmilford\b/.test(text) && groceryName(text)) return true;
  // Do not carry a previous Milford result into an explicit Hamden search.
  if (/\bhamden\b/.test(text)) return false;
  const words = text.replace(/\btjs?\b/g, 'trader joes').split(/\s+/);
  return results.some(place => {
    const name = normalize(place.display_name).replace(/\s/g, '');
    return isMilfordGroceryPlace(place) && words.every(word => name.includes(word));
  });
}
