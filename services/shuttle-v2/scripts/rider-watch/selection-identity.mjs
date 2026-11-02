const bare = value => {
  const name = typeof value === 'string' ? value.replace(/^#/, '').trim() : '';
  return /^[A-Za-z0-9-]{1,24}$/.test(name) ? name : null;
};
const stop = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Metadata only. This never selects a bus or changes a boarding decision. */
export function runnerBinding(run) {
  return { phase: run?.phase ?? null, routeLabel: run?.line?.label ?? null,
    routeIds: Array.isArray(run?.line?.busRouteIds) ? [...run.line.busRouteIds] : [],
    busName: bare(run?.busName), boardStopId: stop(run?.boardStopId),
    alightStopId: stop(run?.exitStopId), transferStage: run?.transfer?.stage ?? null };
}

/** Read only the expanded itinerary, not the first bus named anywhere in body.
 * The public panel contains its timing table and route-specific stop region.
 * An overview, hidden panel, missing identity or multiple matches is unknown. */
export async function readWaitingSelection(page, routeLabel) {
  try {
    const panels = await page.locator('[data-testid="map-trip-panel"]').evaluateAll((elements, label) => {
      const visible = node => !!node && node.getClientRects().length > 0
        && getComputedStyle(node).visibility !== 'hidden';
      const shown = elements.filter(visible);
      if (shown.length > 8) return [{ overflow: true }];
      return shown.map(panel => {
        const regions = [...panel.querySelectorAll('[data-testid="trip-stop-list"]')]
          .filter(node => visible(node) && node.getAttribute('aria-label') === label + ' stops');
        const tables = [...panel.querySelectorAll('[data-testid="route-timing-table"]')].filter(visible);
        const rows = tables.flatMap(table => [...table.querySelectorAll('tbody[data-mode="shuttle"][data-route]')])
          .filter(node => visible(node) && node.dataset.route === label);
        const text = regions.length === 1 ? regions[0].innerText : '';
        return { regionCount: regions.length, tableCount: tables.length, rowCount: rows.length,
          textOverflow: text.length > 4096,
          approachNames: text.length <= 4096 ? [...text.matchAll(/(?:^|\n)🚌 #([A-Za-z0-9-]{1,24}) · \d+ stops? away(?=\n|$)/g)].map(m => m[1]) : [],
          rows: rows.slice(0, 64).map(node => ({ routeLabel: node.dataset.route,
            boardStopId: Number(node.dataset.pickup), alightStopId: Number(node.dataset.alight),
            countdownBus: node.dataset.countdownBus ?? null, boardBus: node.dataset.boardBus ?? null })) };
      });
    }, routeLabel);
    const unknown = reason => ({ v: 1, state: 'unknown', reason, routeLabel });
    if (!Array.isArray(panels) || panels.some(p => p.overflow)) return unknown('panel-bound-exceeded');
    const expanded = panels.filter(p => p.regionCount > 0);
    if (expanded.length !== 1) return unknown(expanded.length ? 'ambiguous-expanded-panel' : 'expanded-panel-unavailable');
    const panel = expanded[0];
    if (panel.regionCount !== 1 || panel.tableCount !== 1 || panel.rowCount !== 1)
      return unknown('ambiguous-itinerary-row');
    if (panel.textOverflow || panel.approachNames.length > 1) return unknown('ambiguous-approach-identity');
    const row = panel.rows[0], countdownBus = bare(row.countdownBus), boardBus = bare(row.boardBus);
    if (row.routeLabel !== routeLabel || stop(row.boardStopId) === null || stop(row.alightStopId) === null
      || !countdownBus || !boardBus) return unknown('itinerary-identity-unavailable');
    const approachBus = panel.approachNames[0] ?? null;
    if (approachBus && approachBus !== countdownBus) return unknown('approach-countdown-disagreement');
    return { v: 1, state: 'bound', routeLabel, boardStopId: row.boardStopId, alightStopId: row.alightStopId,
      countdownBus, boardBus, approachBus, source: 'visible-expanded-itinerary-dom' };
  } catch (error) {
    return { v: 1, state: 'unknown', reason: 'dom-read-unavailable', routeLabel,
      error: String(error?.message ?? error).slice(0, 256) };
  }
}

/** Separate events keep metadata out of the legacy forecast sample stream. */
export function bindingObservation(record, at) {
  return { at, runId: record.runId, line: record.line, kind: 'sample-binding-observed', detail: {
    v: 1, sampleId: record.sampleId, sampledAt: record.sampledAt, stage: record.stage,
    before: record.before, after: record.after, selection: record.selection,
    feedResponse: record.feedResponse, feedStableDuringRead: record.feedStableDuringRead,
    changed: record.after === null ? null : JSON.stringify(record.before) !== JSON.stringify(record.after),
  } };
}
