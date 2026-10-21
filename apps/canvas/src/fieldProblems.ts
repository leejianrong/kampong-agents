import { createContext, useRef } from "react";

// Which fields of a form have a problem showing (KAM-194). An expression field checks what is typed and says so
// beside itself; a form that saves through the server must not then send what the field already called wrong, or
// the same failure comes back a second time in the server's words. The fields report here, and the form asks
// before it saves.

export interface FieldProblems {
  /** A field says whether it has a problem now: the element to focus when it does, null when it does not. */
  report(id: string, element: HTMLElement | null): void;
  /** The first field with a problem, if any, in the order they reported. */
  firstInvalid(): HTMLElement | null;
}

export const FieldProblemsContext = createContext<FieldProblems | null>(null);

/** One registry for one form; the same object for the life of the form. */
export function useFieldProblems(): FieldProblems {
  const registry = useRef<FieldProblems | null>(null);
  if (!registry.current) {
    const invalid = new Map<string, HTMLElement>();
    registry.current = {
      report(id, element) {
        if (element) invalid.set(id, element);
        else invalid.delete(id);
      },
      firstInvalid() {
        for (const element of invalid.values()) return element;
        return null;
      },
    };
  }
  return registry.current;
}
