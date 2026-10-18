import { useLayoutEffect, type RefObject } from "react";

// A textarea that is as tall as its text, up to `maxPx`, then scrolls. `rows` cannot do this: it counts lines
// break by break, not lines as they wrap in a narrow panel, so a long prompt was cut off mid-sentence (KAM-166).
// jsdom has no layout (scrollHeight is 0), so the height is left alone there.
export function useAutoHeight(
  ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  enabled = true,
  maxPx = 360,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || el.tagName !== "TEXTAREA") return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(el.scrollHeight + 2, maxPx)}px`;
      el.style.overflowY = el.scrollHeight + 2 > maxPx ? "auto" : "hidden";
    }
  }, [ref, value, enabled, maxPx]);
}
