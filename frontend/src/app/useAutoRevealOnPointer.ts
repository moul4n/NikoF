import { useEffect, useRef, useState } from "react";

const DEFAULT_HIDE_DELAY_MS = 2500;

/**
 * Returns true while the pointer has moved recently, then false after an idle
 * delay — the "video player controls" reveal pattern used by the stage window's
 * floating controls so they stay out of the way of the avatar.
 */
export function useAutoRevealOnPointer(hideDelayMs: number = DEFAULT_HIDE_DELAY_MS): boolean {
  const [revealed, setRevealed] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    function reveal(): void {
      setRevealed(true);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = window.setTimeout(() => setRevealed(false), hideDelayMs);
    }

    window.addEventListener("mousemove", reveal);
    window.addEventListener("pointerdown", reveal);
    return () => {
      window.removeEventListener("mousemove", reveal);
      window.removeEventListener("pointerdown", reveal);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [hideDelayMs]);

  return revealed;
}
