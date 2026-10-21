import { useLayoutEffect, useRef, useState } from "react";
import type { Coach, CoachMark } from "./coachMarks.js";

// The card for the mark the tour is on (KAM-220). It sits near what it points at without taking focus or covering it,
// is announced politely, and is reachable by keyboard (Tab to Skip tour or Got it; Escape from inside it skips).

const TEXT: Record<CoachMark, (replay: boolean) => string> = {
  template: () => "Pick a template to start from. You can change every step afterwards.",
  run: (replay) =>
    replay
      ? "Press Run to try it. Replay uses recorded data, so no keys are needed."
      : "Press Run to try the workflow.",
  step: () => "Click a step to see the data it handled in this run.",
};

const ANCHOR: Record<CoachMark, string> = {
  template: ".md3-app__canvas-pane",
  run: '[data-testid="run-button"]',
  step: ".md3-app__canvas-pane",
};

const MARGIN = 12;

interface Place {
  top: number;
  left: number;
  /** The card hangs under its target and points up at it. */
  below: boolean;
  /** Where the pointer sits along the card's top edge. */
  pointer: number;
}

export function CoachMarks({ coach, replay }: { coach: Coach; replay: boolean }) {
  const { mark } = coach;
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);

  useLayoutEffect(() => {
    if (!mark) return;
    function measure() {
      const target = document.querySelector(ANCHOR[mark!]);
      const el = card.current;
      if (!el) return;
      // Nothing to point at (the anchor is not on screen): sit at the bottom left rather than vanish.
      if (!target) {
        return setPlace({
          top: Math.max(MARGIN, window.innerHeight - el.offsetHeight - 56),
          left: MARGIN,
          below: false,
          pointer: 0,
        });
      }
      const box = target.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const room = window.innerWidth - width - MARGIN;
      if (mark === "run") {
        const left = Math.max(MARGIN, Math.min(box.left, room));
        setPlace({
          top: box.bottom + 10,
          left,
          below: true,
          pointer: Math.max(16, Math.min(box.left + box.width / 2 - left, width - 16)),
        });
      } else {
        // In the canvas pane, along its bottom, clear of the controls in its corners.
        setPlace({
          top: Math.max(MARGIN, box.bottom - height - 56),
          left: Math.max(MARGIN, Math.min(box.left + (box.width - width) / 2, room)),
          below: false,
          pointer: 0,
        });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = document.querySelector(ANCHOR[mark]);
    if (target) observer?.observe(target);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [mark]);

  if (!mark || !coach.position) return null;
  return (
    <div
      ref={card}
      role="region"
      aria-label={`Tour, step ${coach.position.at} of ${coach.position.of}`}
      aria-live="polite"
      className={`md3-coach${place?.below ? " md3-coach--below" : ""}`}
      data-testid="coach-mark"
      data-mark={mark}
      style={
        place
          ? {
              top: place.top,
              left: place.left,
              ["--coach-pointer" as string]: `${place.pointer}px`,
            }
          : { visibility: "hidden" }
      }
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          coach.skip();
        }
      }}
    >
      <p className="md3-body-medium md3-coach__text">{TEXT[mark](replay)}</p>
      <div className="md3-coach__actions">
        <span className="md3-body-small md3-coach__count">
          {coach.position.at} of {coach.position.of}
        </span>
        <button type="button" className="md3-button md3-button-text" onClick={coach.skip}>
          Skip tour
        </button>
        {mark === "step" && (
          <button type="button" className="md3-button md3-button-tonal" onClick={coach.next}>
            Got it
          </button>
        )}
      </div>
    </div>
  );
}
