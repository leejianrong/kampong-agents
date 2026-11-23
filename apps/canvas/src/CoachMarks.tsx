import { useLayoutEffect, useRef, useState } from "react";
import type { Coach, CoachMark } from "./coachMarks.js";

// The card for the mark the tour is on (KAM-220). It sits near what it points at without taking focus or covering it,
// is announced politely, and is reachable by keyboard (Tab to Skip tour or Got it; Escape from inside it skips).

const TEXT: Record<CoachMark, (replay: boolean, phone: boolean) => string> = {
  template: () => "Pick a template to start from. You can change every step afterwards.",
  run: (replay) =>
    replay
      ? "Press Run to try it. Replay uses recorded data, so no keys are needed."
      : "Press Run to try the workflow.",
  step: (_replay, phone) =>
    phone
      ? "Tap a step in the list to see the data it handled in this run."
      : "Click a step to see the data it handled in this run.",
};

const ANCHOR: Record<CoachMark, string> = {
  template: ".md3-app__canvas-pane",
  run: '[data-testid="run-button"]',
  step: ".md3-app__canvas-pane",
};

const MARGIN = 12;

const isPhone = () => window.matchMedia?.("(max-width: 600px)").matches === true;

type Rect = { left: number; top: number; right: number; bottom: number };
const hits = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

interface Place {
  top: number;
  left: number;
  /** The card hangs under its target and points up at it. */
  below: boolean;
  /** Where the pointer sits along the card's top edge. */
  pointer: number;
}

/**
 * The template mark beside the new-workflow card, level with its top, when the pane is wide enough to leave room on
 * the right. Returns whether it placed the card; otherwise the caller puts it along the pane's bottom.
 */
function besideEmptyCard(
  pane: DOMRect,
  width: number,
  height: number,
  place: (p: Place) => void,
): boolean {
  const card = document.querySelector(".md3-empty-state__card")?.getBoundingClientRect();
  if (!card) return false;
  if (pane.right - card.right < width + MARGIN * 2) return false;
  place({
    top: Math.max(MARGIN, Math.min(card.top, window.innerHeight - height - 56)),
    left: card.right + MARGIN,
    below: false,
    pointer: 0,
  });
  return true;
}

export function CoachMarks({ coach, replay }: { coach: Coach; replay: boolean }) {
  const { mark } = coach;
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);

  useLayoutEffect(() => {
    if (!mark) return;
    function measure() {
      const phone = isPhone();
      // On a phone the open log is a sheet over the canvas, so the step to click is a row in its list (KAM-305).
      const anchor = mark === "step" && phone ? ".md3-runlog__rows" : ANCHOR[mark!];
      const target = document.querySelector(anchor);
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
      if (mark === "step" && phone) {
        // Along the screen's bottom, over the empty part of the sheet below the step's detail.
        setPlace({
          top: Math.max(MARGIN, window.innerHeight - height - MARGIN),
          left: MARGIN,
          below: false,
          pointer: 0,
        });
      } else if (mark === "run" && window.innerWidth - box.right > width + MARGIN * 2) {
        // Beside the button, in the run bar's empty stretch, so it covers neither the palette nor the canvas's
        // first cards (KAM-305).
        setPlace({
          top: Math.max(MARGIN, box.top - 4),
          left: box.right + 10,
          below: false,
          pointer: 0,
        });
      } else if (mark === "run") {
        const left = Math.max(MARGIN, Math.min(box.left, room));
        setPlace({
          top: box.bottom + 10,
          left,
          below: true,
          pointer: Math.max(16, Math.min(box.left + box.width / 2 - left, width - 16)),
        });
      } else if (mark === "template" && besideEmptyCard(box, width, height, setPlace)) {
        // KAM-285: to the side of the empty state's card, where it hides none of the templates.
      } else if (mark === "template") {
        // No room beside the card: along the window's bottom edge, over the status bar, which a blank workflow
        // has no use for, so the templates above it are never covered (KAM-285).
        setPlace({
          top: Math.max(MARGIN, window.innerHeight - height - 6),
          left: MARGIN,
          below: false,
          pointer: 0,
        });
      } else {
        // In the canvas pane, clear of the controls in its corners and of every card: the first of these spots
        // that none of the cards is under (KAM-305), else along the bottom.
        const centred = Math.max(MARGIN, Math.min(box.left + (box.width - width) / 2, room));
        const bottom = Math.max(MARGIN, box.bottom - height - 56);
        const spots = [
          { left: centred, top: bottom },
          { left: Math.max(MARGIN, room - 56), top: bottom },
          { left: box.left + 64, top: bottom },
          { left: centred, top: box.top + MARGIN },
        ];
        // A short canvas has no clear spot; the run bar's empty stretch, to the right of the outcome, is another.
        const chip = document
          .querySelector('[data-testid="runbar-status"]')
          ?.getBoundingClientRect();
        const bar = document.querySelector(".md3-runbar")?.getBoundingClientRect();
        if (chip && bar && window.innerWidth - chip.right > width + MARGIN * 2) {
          spots.push({ left: chip.right + MARGIN, top: Math.max(MARGIN, bar.top + 4) });
        }
        const cards = [...document.querySelectorAll(".react-flow__node")].map((n) =>
          n.getBoundingClientRect(),
        );
        // The least of the cards covered: none where there is room, and the smallest area where there is not.
        const covered = (spot: { left: number; top: number }) => {
          const r = {
            left: spot.left,
            top: spot.top,
            right: spot.left + width,
            bottom: spot.top + height,
          };
          return cards.reduce((sum, c) => {
            const w = Math.min(r.right, c.right) - Math.max(r.left, c.left);
            const h = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
            return sum + (w > 0 && h > 0 ? w * h : 0);
          }, 0);
        };
        const at = spots.reduce(
          (best, spot) => (covered(spot) < covered(best) ? spot : best),
          spots[0]!,
        );
        setPlace({ top: at.top, left: at.left, below: false, pointer: 0 });
      }
    }
    measure();
    // The bar the card sits beside can still be settling (the mode switch arrives with the options), so measure again
    // once it has laid out; the observer below only sees the target change size, not move (KAM-305).
    const settle = [requestAnimationFrame(measure), window.setTimeout(measure, 300)] as const;
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = document.querySelector(ANCHOR[mark]);
    if (target) observer?.observe(target);
    return () => {
      cancelAnimationFrame(settle[0]);
      clearTimeout(settle[1]);
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
      <p className="md3-body-medium md3-coach__text">{TEXT[mark](replay, isPhone())}</p>
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
