import { useEffect, useState } from "react";

/** Below this width the desk is laid out as a phone app: one screen at a time and a tab bar at the bottom. */
export const MOBILE_QUERY = "(max-width: 760px)";

function matches(): boolean {
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return false;
  }
}

/** Follows the screen width live, so rotating a tablet or resizing a window switches layouts on the spot. */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
