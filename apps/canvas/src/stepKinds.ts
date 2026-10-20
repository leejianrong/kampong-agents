// The step kinds "Add Workflow Step" offers, shared with the palette and the "+" picker (KAM-213).

// transform, validate and dedupe (KAN-1860) are version 1.1 steps: the spec's own check, not this form, says
// so if the spec is still 1.0. Their expression fields are plain text, as the condition's `if` is.
export type StepKind =
  | "action"
  | "tool"
  | "approval"
  | "condition"
  | "transform"
  | "validate"
  | "dedupe"
  | "foreach"
  | "branch"
  | "stop";

// KAM-176: what each kind does, in task words, shown under the picker when it is selected.
export const KIND_HELP: Record<StepKind, { label: string; what: string; example: string }> = {
  action: {
    label: "Action",
    what: "Ask the model to do something and keep its answer.",
    example: "Example: write a reply to the customer's email.",
  },
  tool: {
    label: "Tool",
    what: "Call one of the tools you added, such as a web request or a Slack message.",
    example: "Example: post the reply to the support channel.",
  },
  approval: {
    label: "Approval",
    what: "Wait for a person to approve before the run goes on.",
    example: "Example: let a manager check a refund before it is sent.",
  },
  condition: {
    label: "Condition",
    what: "Do this only if a condition is true, otherwise do something else (older specs).",
    example: "Example: if the order is over 100, go to the approval step.",
  },
  transform: {
    label: "Transform",
    what: "Work out new values from earlier results, without asking the model.",
    example: "Example: total = price * quantity.",
  },
  validate: {
    label: "Validate",
    what: "Check that the data looks right, and stop or skip the item if it does not.",
    example: "Example: the email address must not be empty.",
  },
  dedupe: {
    label: "Dedupe",
    what: "Skip anything already handled within a time window.",
    example: "Example: ignore a ticket seen in the last 24h.",
  },
  foreach: {
    label: "Foreach",
    what: "Repeat the steps inside for each item in a list.",
    example: "Example: for each stock symbol, fetch its price.",
  },
  branch: {
    label: "Branch",
    what: "Choose between groups of steps: do this only if something is true, or pick by value.",
    example: "Example: if the move is over 5%, send an alert; otherwise carry on.",
  },
  stop: {
    label: "Stop",
    what: "End the run here, with a reason.",
    example: "Example: nothing new today, so stop.",
  },
};

/** Other words people use for a kind, matched by the search but not shown. */
export const KIND_KEYWORDS: Record<StepKind, string> = {
  action: "ask model llm ai prompt generate write",
  tool: "call http request api slack email",
  approval: "human review manual sign off confirm",
  condition: "if else when",
  transform: "set compute map calculate values",
  validate: "check assert verify",
  dedupe: "duplicate once unique already seen",
  foreach: "loop repeat each list iterate",
  branch: "if else switch case route decide",
  stop: "end halt exit finish",
};

export interface KindCategory {
  id: string;
  label: string;
  kinds: StepKind[];
}

/** How the palette and the picker group the kinds (KAM-213). */
export const KIND_CATEGORIES: KindCategory[] = [
  { id: "work", label: "Do work", kinds: ["action", "tool", "approval"] },
  { id: "data", label: "Work with data", kinds: ["transform", "validate", "dedupe"] },
  { id: "flow", label: "Control the flow", kinds: ["foreach", "branch", "stop", "condition"] },
];

/** The kinds on offer for a spec version: the older Condition is hidden on "1.1", where Branch does its job. */
export function pickableKinds(version?: string): StepKind[] {
  return KIND_CATEGORIES.flatMap((c) => c.kinds).filter(
    (k) => !(k === "condition" && version === "1.1"),
  );
}
