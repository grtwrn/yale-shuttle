import { CANARY_LINES, haversineM, liveBusesOf } from '../canary-metrics.mjs';

const bare = name => String(name ?? '').replace(/^#/, '');
export function riderLineAllowed(label, allowedLabels, randomLines) {
  return (!allowedLabels || allowedLabels.includes(label)) && (!randomLines || label !== 'Red');
}
export function riderAssignmentAllows(run, allowedLabels, randomLines) {
  const labels = [run?.line?.label, ...(run?.transfer?.legs?.map(l => l.routeLabel) ?? [])];
  return labels.every(label => CANARY_LINES.some(line => line.label === label) && riderLineAllowed(label, allowedLabels, randomLines));
}
export function transferChoiceLabels(name) {
  for (const first of CANARY_LINES) for (const second of CANARY_LINES) {
    if (first.label !== second.label && String(name).startsWith(`View ${first.label} to ${second.label} transfer from `))
      return [first.label, second.label];
  }
  return null;
}

/** Read the rendered itinerary and its existing public feedback attributes.
 * Keep original text; a boarding assessment derived from attributes is never
 * described as literal rider-visible text or an independent arrival label. */
export async function readTransferSections(page) {
  return page.locator('[data-feedback-transfer-ride]').evaluateAll(elements => elements
    .filter(el => el.getClientRects().length > 0).map(el => {
      const integer = key => { const value = el.getAttribute(key); return value !== null && /^\d+$/.test(value) ? Number(value) : null; };
      const controls = el.querySelector('[data-testid="transfer-pickup-controls"]');
      return { routeLabel: el.getAttribute('data-route'), boardStopId: integer('data-pickup'), exitStopId: integer('data-alight'),
        boardBusName: el.getAttribute('data-board-bus'), countdownBusName: el.getAttribute('data-countdown-bus'),
        boardingStopsAhead: integer('data-board-stops-ahead'), controls: !!controls,
        text: el.innerText, controlText: controls?.innerText ?? '',
        buttons: controls ? [...controls.querySelectorAll('button')].map(b => b.innerText.trim()) : [] };
    }));
}
export function validTransferLeg(section, feed, allowedLabels, randomLines) {
  const line = CANARY_LINES.find(l => l.label === section?.routeLabel);
  if (!line || !riderLineAllowed(line.label, allowedLabels, randomLines)) return false;
  const sequence = feed.routes?.[line.busRouteIds[0]];
  return Array.isArray(sequence) && section.boardStopId !== section.exitStopId
    && [section.boardStopId, section.exitStopId].every(id => Number.isSafeInteger(id)
      && sequence.filter(s => s === id).length === 1
      && [feed.stop_coords?.[id]?.lat, feed.stop_coords?.[id]?.lon].every(Number.isFinite));
}
export async function selectTransferTrip(page, feed, firstLine, allowedLabels, randomLines) {
  const show = page.getByRole('button', { name: /^Show \d+( more)? transfer options$/ });
  if (await show.first().isVisible()) await show.first().click();
  const choices = await page.getByRole('button', { name: /^View .+ to .+ transfer from / }).all();
  if (choices.length > 64) throw Error('Unexpected transfer option count');
  for (const choice of choices) {
    const labels = transferChoiceLabels(await choice.getAttribute('aria-label'));
    if (!labels || labels[0] !== firstLine.label || labels.some(label => !riderLineAllowed(label, allowedLabels, randomLines))) continue;
    const lines = labels.map(label => CANARY_LINES.find(l => l.label === label));
    if (lines.some(line => !liveBusesOf(feed, line).length)) continue;
    await choice.click();
    await page.getByTestId('transfer-detail').waitFor({ timeout: 5000 });
    const sections = await readTransferSections(page);
    if (sections.length !== 2 || !sections[0].controls || sections[1].controls
      || sections.some((section, i) => section.routeLabel !== labels[i] || !validTransferLeg(section, feed, allowedLabels, randomLines)))
      throw Error('Selected transfer has ambiguous or changed leg identities');
    return { legs: sections.map(s => ({ routeLabel: s.routeLabel, boardStopId: s.boardStopId, exitStopId: s.exitStopId })), selectedText: sections.map(s => s.text) };
  }
  return null;
}
export function sameTransferLeg(a, b) {
  return !!a && !!b && a.routeLabel === b.routeLabel && a.boardStopId === b.boardStopId && a.exitStopId === b.exitStopId;
}
export function transferWaitingContext(sections, expected, feed) {
  const active = sections.filter(s => s.controls);
  if (active.length !== 1 || !sameTransferLeg(active[0], expected)) return null;
  const section = active[0], line = CANARY_LINES.find(l => l.label === section.routeLabel);
  const names = feed.buses.filter(b => bare(b.bus_name) === bare(section.boardBusName) && line?.busRouteIds.includes(b.route_id));
  const name = section.boardBusName && names.length === 1 ? names[0].bus_name : null;
  const hops = section.boardingStopsAhead;
  const namedButton = name ? `🚌 I'm on #${bare(name)}` : null;
  const buttonName = namedButton && section.buttons.includes(namedButton) ? namedButton
    : section.buttons.includes("🚌 I'm on it") ? "🚌 I'm on it" : null;
  // This string is only input to the existing occurrence/curb boarding vetoes.
  const assessmentText = `${name && Number.isSafeInteger(hops) ? `🚌 ${name} · ${hops} stops away\n` : ''}BOARD${hops === 0 ? '🚌' : ''}${feed.stop_names?.[section.boardStopId] ?? ''}\nGET OFF${feed.stop_names?.[section.exitStopId] ?? ''}`;
  return { ...section, busName: name, buttonName, assessmentText, assessmentDerivedFromPublicAttributes: true };
}
export function transferLegTrip(original, leg, feed, origin = original.origin) {
  const point = feed.stop_coords?.[leg.exitStopId];
  if (!point) throw Error('Transfer exit coordinates unavailable');
  return { kind: 'transfer-leg', origin: { ...origin }, destination: { ...point,
    stopId: leg.exitStopId, display_name: feed.stop_names?.[leg.exitStopId] ?? `Stop ${leg.exitStopId}`, type: 'bus_stop', class: 'shuttle' } };
}
export function completedLegRecord(run, result = 'arrived') {
  const { transfer, ...leg } = run;
  return { ...leg, result };
}
export function boardedTransferMatches(ride, transfer) {
  const expected = transfer.legs[transfer.stage];
  if (!sameTransferLeg({ routeLabel: ride?.routeLabel, boardStopId: ride?.boardStopId, exitStopId: ride?.alightStopId }, expected)) return false;
  const destination = transfer.originalTrip.destination;
  if (transfer.stage === 0) {
    const next = ride.onward?.next, point = ride.onward?.destination;
    return sameTransferLeg({ routeLabel: next?.routeLabel, boardStopId: next?.boardStopId, exitStopId: next?.alightStopId }, transfer.legs[1])
      && !!point && haversineM(point, destination) <= 80;
  }
  return !ride.onward && Number.isFinite(ride.toLat) && Number.isFinite(ride.toLon)
    && haversineM({ lat: ride.toLat, lon: ride.toLon }, destination) <= 80;
}
export function nextTransferStage(run, feed, now) {
  const transfer = run.transfer, arrival = run.arrivalObservation, boarded = Date.parse(run.boardedAt);
  if (transfer?.stage !== 0 || run.phase !== 'arrived' || !arrival
    || arrival.stopId !== run.exitStopId || bare(arrival.bus?.bus_name) !== bare(run.busName)
    || !run.line.busRouteIds.includes(arrival.bus?.route_id)
    || !Number.isFinite(boarded) || Date.parse(arrival.receivedAt) - boarded <= 30000)
    throw Error('An observed first-leg arrival is required for transfer');
  const distance = haversineM(arrival.bus, arrival.stopCoords);
  if (!Number.isFinite(distance) || !(distance <= 45 || distance <= 60 && arrival.bus.stationary === true && arrival.bus.at_stop_id === run.exitStopId))
    throw Error('First-leg arrival receipt does not meet the rider observation rule');
  const next = transfer.legs[1], line = CANARY_LINES.find(l => l.label === next.routeLabel);
  if (!line || !validTransferLeg(next, feed, transfer.allowedLabels, true)) throw Error('Next transfer leg changed or is not assigned to this rider');
  const origin = { lat: arrival.bus.lat, lon: arrival.bus.lon, label: arrival.stopName ?? `Stop ${run.exitStopId}`, stopId: run.exitStopId };
  return { instrumentVersion: 'transfer-v1', id: run.id, phase: 'waiting', startedAt: new Date(now).toISOString(), line,
    trip: transferLegTrip(transfer.originalTrip, next, feed, origin), samples: 0, excludeAccuracy: true,
    excludeAccuracyReason: 'Two-leg diagnostic; separate from one-seat accuracy aggregates',
    transfer: { ...transfer, stage: 1, completedLegs: [...transfer.completedLegs, completedLegRecord(run)], handoffAt: new Date(now).toISOString() } };
}
