// Blend adjacent calibration buckets over one displayed minute. A bus crossing
// a bucket boundary has not suddenly become more or less predictable. Keep the
// fitted factor outside that small transition, including the uncalibrated tail.
export function conformalFactor(eta, table) {
  const edges = [120, 300, 600, 1800];
  const factors = [table['0-2'], table['2-5'], table['5-10'], table['10-30'], 1];
  const halfWindow = 30;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (eta < edge - halfWindow) return factors[i];
    if (eta <= edge + halfWindow) {
      const fraction = (eta - edge + halfWindow) / (2 * halfWindow);
      return factors[i] + (factors[i + 1] - factors[i]) * fraction;
    }
  }
  return 1;
}
