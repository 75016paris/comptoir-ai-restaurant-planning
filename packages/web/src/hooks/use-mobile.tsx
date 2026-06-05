import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768;
// Below Tailwind `lg` — phones + tablets in portrait. Used by views that need
// a single-day layout on anything narrower than a laptop (e.g. /schedule stack).
const COMPACT_BREAKPOINT = 1024;

function useMatchesMaxWidth(maxPx: number): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(`(max-width: ${maxPx - 1}px)`).matches);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${maxPx - 1}px)`);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [maxPx]);
  return matches;
}

export function useIsMobile() {
  return useMatchesMaxWidth(MOBILE_BREAKPOINT);
}

export function useIsCompact() {
  return useMatchesMaxWidth(COMPACT_BREAKPOINT);
}
