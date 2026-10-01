import { useCallback, useEffect, useRef, useState } from "react";

/** The map and its toggle stay mounted when its viewport expands/contracts. */
export function useMapFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const closeFullscreen = useCallback((restoreFocus = true) => {
    setFullscreen(false);
    // Back disappears on close. Focus the persistent toggle before that
    // happens, without scrolling the underlying trip away from its place.
    if (restoreFocus) toggleRef.current?.focus({ preventScroll: true });
  }, []);

  const toggleFullscreen = () => {
    if (fullscreen) closeFullscreen();
    else setFullscreen(true);
  };

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape still closes the map if focus has moved outside it, but must
      // not take focus back from another control the rider has reached.
      closeFullscreen(wrapperRef.current?.contains(document.activeElement) ?? false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, closeFullscreen]);

  return { fullscreen, wrapperRef, toggleRef, closeFullscreen, toggleFullscreen };
}
