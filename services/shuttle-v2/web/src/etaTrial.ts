/** K10 is the Red default; other routes retain their existing estimator. */
export function k10TrialSelected(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  return new URLSearchParams(search).get('eta_model') !== 'usual';
}
export function etaTrialQuery(): string { return k10TrialSelected() ? '' : 'eta_model=usual'; }
export function etaChoiceUrl(href: string, usual: boolean): string {
  const url = new URL(href);
  if (usual) url.searchParams.set('eta_model', 'usual');
  else url.searchParams.delete('eta_model');
  return url.pathname + url.search + url.hash;
}

export const K10_TRIAL_ROUTES = ['Red', 'Blue Day', 'Blue West'] as readonly string[];
