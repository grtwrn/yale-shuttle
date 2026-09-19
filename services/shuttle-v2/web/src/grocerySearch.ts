const normalize = (text: string) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ');
const traderJoes = (text: string) => /\b(?:trader\s*joes?|tjs?)\b/.test(text);

/** Warn on the Milford branch, including its result under a generic store search. */
export function isMilfordGrocerySearch(query: string, resultNames: readonly string[] = []): boolean {
  const text = normalize(query);
  if (!traderJoes(text)) return false;
  if (/\bmilford\b/.test(text)) return true;
  // Do not carry a previous Milford result into an explicit Hamden search.
  if (/\bhamden\b/.test(text)) return false;
  return resultNames.some(name => {
    const result = normalize(name);
    return traderJoes(result) && /\bmilford\b/.test(result);
  });
}
