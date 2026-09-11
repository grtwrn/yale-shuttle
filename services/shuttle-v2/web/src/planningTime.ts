/** A calendar choice must not silently fall back to live predictions. */
export function planningTimeError(value: string, now = Date.now()): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "Choose a valid departure time or tap Now.";
  // The picker has minute precision. Allow the current minute, which may
  // already be up to 59 seconds old when the rider opens it.
  return at < now - 60_000 ? "Choose a future time or tap Now." : null;
}
