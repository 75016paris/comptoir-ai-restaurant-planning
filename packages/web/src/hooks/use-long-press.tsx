import { useRef, useCallback } from "react";

const LONG_PRESS_MS = 800;
const MOVE_THRESHOLD = 10;

/** Returns onTouchStart / onTouchMove / onTouchEnd handlers for long-press detection.
 *  Pass stopPropagation: true to prevent parent long-press handlers from also firing. */
export function useLongPress(onLongPress: () => void, opts?: { stopPropagation?: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const stop = opts?.stopPropagation ?? false;

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    startPos.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (stop) e.stopPropagation();
      fired.current = false;
      const t = e.touches[0];
      startPos.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [onLongPress, stop],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current) return;
      const t = e.touches[0];
      const dx = t.clientX - startPos.current.x;
      const dy = t.clientY - startPos.current.y;
      if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
        cancel();
      }
    },
    [cancel],
  );

  const onTouchEnd = useCallback(() => {
    cancel();
  }, [cancel]);

  return { onTouchStart, onTouchMove, onTouchEnd, firedRef: fired };
}
