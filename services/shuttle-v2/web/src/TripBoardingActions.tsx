import { useCallback, useRef } from 'react';

/** Keep the manual escape hatch for the approaching bus as well as the bus
 * priced by the journey. Each action names the vehicle it will track. */
export function TripBoardingActions({ pickup, ride, different, onBoard }: {
  pickup: string;
  ride: string;
  different: boolean;
  onBoard: (busName: string) => void;
}) {
  const pickupRef = useRef<HTMLButtonElement | null>(null);
  const rideRef = useRef<HTMLButtonElement | null>(null);
  // A forecast can disappear during keyboard use. Return to the persistent
  // manual action only if the disappearing action still owns focus.
  const setRideRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button && rideRef.current === document.activeElement) pickupRef.current?.focus();
    rideRef.current = button;
  }, []);
  const button = (busName: string, isRide: boolean) => (
    <button
      key={isRide ? 'journey' : 'pickup'}
      ref={isRide ? setRideRef : pickupRef}
      className="trip-action-button"
      onClick={(e) => { e.stopPropagation(); onBoard(busName); }}
      title="Track this ride now — use this if the app didn't notice you boarding"
    >
      🚌 {different ? `I'm on #${busName}` : "I'm on it"}
    </button>
  );
  return <>{different && button(ride, true)}{button(pickup, false)}</>;
}
