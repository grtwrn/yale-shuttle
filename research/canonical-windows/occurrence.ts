/** Resolve from causal evidence only. A physical stop can have several passes. */
export function resolveOccurrence(seq: readonly number[], target: number, hops: number,
  phaseIndex: number, nearest: number, ready: boolean) {
  const indices = seq.flatMap((stop, index) => stop === target ? [index] : []), n = seq.length;
  const no = (reason: string) => ({ targetIndex: null, anchorIndex: null, occurrenceReason: reason });
  if (!indices.length) return no('target outside canonical route');
  if (!Number.isInteger(hops) || hops <= 0 || hops >= n) return no('later lap or invalid hop count');
  if (indices.length === 1) return { targetIndex: indices[0]!, anchorIndex: (indices[0]! - hops + n) % n,
    occurrenceReason: 'unique physical target' };
  if (!ready || phaseIndex < 0 || phaseIndex >= n || nearest < 0 || nearest >= n)
    return no('repeated target lacks fresh causal anchors');
  const candidates = [phaseIndex, nearest].map(anchor => (anchor + hops) % n);
  if (candidates.some(index => seq[index] !== target)) return no('repeated target disagrees with causal anchors');
  if (candidates[0] !== candidates[1]) return no('repeated target has multiple causal occurrences');
  return { targetIndex: candidates[0]!, anchorIndex: phaseIndex, occurrenceReason: 'causal anchors agree on repeated target' };
}
