// KAM-284: what happens after an approval, for the dialog to say before the person decides. The approval step may sit
// at the top of the workflow or inside a branch arm or a loop, so the step after it is found in whichever list holds it.

type Step = { step?: unknown } & Record<string, unknown>;

const isStepList = (value: unknown): value is Step[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((v) => typeof v === "object" && v !== null && typeof (v as Step).step === "string");

/** Every list of steps inside a value: the workflow itself, a branch's arms, a loop's body. */
function stepLists(value: unknown, out: Step[][] = []): Step[][] {
  if (isStepList(value)) {
    out.push(value);
    for (const step of value) for (const inner of Object.values(step)) stepLists(inner, out);
  } else if (Array.isArray(value)) {
    for (const v of value) stepLists(v, out);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) stepLists(v, out);
  }
  return out;
}

/**
 * The name of the step that runs after `name` in the list it sits in: a string, or null when it is the last one of
 * its list (the run goes on from the end of its arm or loop), or undefined when the step is not in the workflow.
 */
export function stepAfter(workflow: unknown, name: string): string | null | undefined {
  for (const list of stepLists(workflow)) {
    const i = list.findIndex((s) => s.step === name);
    if (i >= 0) return (list[i + 1]?.step as string | undefined) ?? null;
  }
  return undefined;
}
