/** Explicit URL opt-in; removing the parameter restores the usual forecast. */
export function k10TrialSelected(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  return new URLSearchParams(search).get('eta_model') === 'k10';
}
export function etaTrialQuery(): string { return k10TrialSelected() ? 'eta_model=k10' : ''; }
export function withoutEtaTrial(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('eta_model');
  return url.pathname + url.search + url.hash;
}
