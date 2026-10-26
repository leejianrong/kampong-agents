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

/** A tool kind the Add Tool form can open on (KAM-244). */
export type ToolStart = {
  kind: "http_request" | "slack_post_message" | "gmail_send" | "component";
  /** For a component: its `id@version`, chosen when the form opens. */
  use?: string;
};

/** A tile in the picker's Connectors group: choosing it opens Add Tool on that connector. */
export interface ConnectorOption {
  id: string;
  label: string;
  what: string;
  /** Letter and colour of its tile (ADR-0059 §7); without a colour the tile keeps the tool colours. */
  brand?: { label: string; color?: string };
  keywords: string;
  start: ToolStart;
}

/** The connectors every spec has: the built-in tools. Installed components are added after these. */
export const BUILT_IN_CONNECTORS: ConnectorOption[] = [
  {
    id: "slack",
    label: "Slack",
    what: "Post a message to a Slack channel.",
    brand: { label: "S", color: "#4A154B" },
    keywords: "chat channel message notify post",
    start: { kind: "slack_post_message" },
  },
  {
    id: "gmail",
    label: "Gmail",
    what: "Send an email.",
    brand: { label: "G", color: "#B3261E" },
    keywords: "email mail send message",
    start: { kind: "gmail_send" },
  },
  {
    id: "http",
    label: "Web request",
    what: "Call any web address and keep what comes back.",
    keywords: "http api url get post fetch endpoint",
    start: { kind: "http_request" },
  },
];

export const CONNECTORS_GROUP = { id: "connectors", label: "Connectors" } as const;

const versionParts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);

/** True when version `a` is newer than `b`, comparing the numbers in each part. */
function isNewer(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * The tiles of the Connectors group: the built-in tools and the installed components. Only the newest version of
 * a component gets a tile, and a built-in tile gives way to a component of the same name (Slack, Gmail).
 */
export function connectorOptions(
  components: {
    id: string;
    version: string;
    title?: string;
    description?: string;
    permissionsSummary: string;
    brand?: { label: string; color?: string };
  }[],
): ConnectorOption[] {
  const newest = new Map<string, (typeof components)[number]>();
  for (const c of components) {
    const had = newest.get(c.id);
    if (!had || isNewer(c.version, had.version)) newest.set(c.id, c);
  }
  const nameOf = (id: string) => id.slice(id.indexOf("/") + 1);
  const covered = new Set([...newest.keys()].map(nameOf));
  return [
    ...BUILT_IN_CONNECTORS.filter((b) => !covered.has(b.id)),
    ...[...newest.values()].map((c): ConnectorOption => {
      const name = nameOf(c.id);
      return {
        id: `${c.id}@${c.version}`,
        label: c.title ?? name,
        what: c.description ?? c.permissionsSummary,
        brand: c.brand ?? { label: (name[0] ?? "?").toUpperCase() },
        keywords: `${c.id} component connector`,
        start: { kind: "component", use: `${c.id}@${c.version}` },
      };
    }),
  ];
}
