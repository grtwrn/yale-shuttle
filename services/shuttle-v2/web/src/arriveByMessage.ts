import type { compareDeadline } from './arriveBy';

type DeadlineComparison = ReturnType<typeof compareDeadline>;
interface DeadlineMessage {
  kind: 'recommendation' | 'buffer' | 'connection' | 'limited' | 'unknown' | 'late';
  heading: string;
  explanation: string;
}

/** Describe the available evidence without changing route selection or times.
 * Inspect every alternative before making an overall lateness statement: the
 * two displayed rows do not necessarily include an unavailable second route. */
export function deadlineMessage(comparison: DeadlineComparison, stopNames: Record<number, string>): DeadlineMessage {
  const { recommendation, rows, future, stale } = comparison;
  const walkAdvice = comparison.walk ? ' Compare walking below.' : '';
  if (recommendation) {
    const walking = recommendation.option.mode === 'walk';
    return {
      kind: 'recommendation',
      heading: walking ? (future ? 'Walking fits your buffer' : 'Walk now')
        : `${recommendation.option.routeLabel} may fit your buffer`,
      explanation: walking
        ? 'The walking estimate gets you there before your target. It avoids the shuttle wait.'
        : `The estimated window fits your target if you catch the bus at ${stopNames[recommendation.option.boardStopId] ?? 'your pickup stop'}. Check the pickup and walking times.`,
    };
  }

  const buffer = rows.find(r => r.status === 'buffer' && !r.caution);
  if (buffer) return {
    kind: 'buffer',
    heading: 'Your buffer may be tight',
    explanation: `${buffer.option.mode === 'walk' ? 'The walking estimate' : `The ${buffer.option.routeLabel} window`} ends by class time, but may leave less time to get inside. Check the trip times.`,
  };

  // A conditional fit is useful, but never becomes an unconditional bus
  // recommendation. Keep the specific reason for caution visible.
  const conditional = rows.find(r => (r.status === 'fits' || r.status === 'buffer') && r.caution);
  if (conditional) {
    const connection = conditional.option.journeyArrival?.catchRisk;
    return {
      kind: connection ? 'connection' : 'limited',
      heading: connection ? 'Check the shuttle connection' : 'Allow extra time for this shuttle',
      explanation: `${conditional.option.routeLabel}: ${conditional.caution}`,
    };
  }

  const unknownShuttle = rows.find(r => r.option.mode === 'shuttle' && r.status === 'unknown');
  const hasShuttleWindow = rows.some(r => r.option.mode === 'shuttle' && r.pointMs !== undefined);
  if (!rows.length || rows.some(r => r.status === 'unknown')) return {
    kind: 'unknown',
    heading: unknownShuttle ? (hasShuttleWindow ? 'Some shuttle times are unavailable' : 'Live shuttle times unavailable')
      : 'Arrival time unavailable',
    explanation: !rows.length ? 'No arrival estimate is available. Check your trip options.'
      : future ? `Check live shuttle arrivals closer to departure.${walkAdvice}`
        : stale ? `Bus updates are interrupted. Check again for a live window.${walkAdvice}`
          : `The ${unknownShuttle?.option.routeLabel ?? 'shuttle'} destination window is missing. Check again for live times.${walkAdvice}`,
  };

  return {
    kind: 'late',
    heading: 'You may arrive after class starts',
    explanation: 'The available estimates extend past class time. Compare the trip times below and allow for delays.',
  };
}
