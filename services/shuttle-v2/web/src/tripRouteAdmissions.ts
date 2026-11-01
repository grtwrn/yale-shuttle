import type { TripOption } from './planner';

/** Added routes belong to one original plan; their live timing is refreshed by
 * the same caller as its original choices. Losing a bus never removes a route. */
export interface TripRouteAdmissions {
  readonly plan: readonly TripOption[];
  readonly options: readonly TripOption[];
}

export function retainedTripRoutes(
  plan: readonly TripOption[] | null,
  admissions: TripRouteAdmissions | null,
): readonly TripOption[] | null {
  return plan && admissions?.plan === plan ? admissions.options : plan;
}

/** Accept only previously absent lines from the existing fresh planner result.
 * Keep existing pickup catalogs, object identities and the original plan key. */
export function admitTripRoutes(
  plan: readonly TripOption[],
  admissions: TripRouteAdmissions | null,
  fresh: readonly TripOption[],
): TripRouteAdmissions | null {
  const options = retainedTripRoutes(plan, admissions)!;
  const labels = new Set(options.map(option => option.routeLabel));
  const additions: TripOption[] = [];
  for (const option of fresh) {
    if (option.mode !== 'shuttle' || labels.has(option.routeLabel)) continue;
    labels.add(option.routeLabel);
    additions.push(option);
  }
  if (!additions.length) return admissions?.plan === plan ? admissions : null;
  return { plan, options: [...options, ...additions] };
}
