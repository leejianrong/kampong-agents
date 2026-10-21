import type { ExpressionScope } from "@kampong/spec";
import { baseStepName, type RunTracker } from "./runStatus.js";

// What the "Insert data" picker offers (KAM-218): every name an expression at this spot may use, each with the value
// the last run gave it when there is one. The names come from the same scope the expression check and completions
// use, so a reference the picker inserts always passes the check; the values come from the run on show (KAM-190).

/** One reference the picker can insert, and a short look at the value behind it. */
export interface PickerItem {
  /** The expression text to insert: `trigger.body.repo`, `quote.price`, `items[0].symbol`. */
  path: string;
  /** The value from the last run, shortened to one line; absent when no run has produced it. */
  preview?: string;
}

export interface PickerGroup {
  id: string;
  title: string;
  /** Where the group's values come from, in words. */
  note: string;
  /** Whether any item has a value from a run. */
  sampled: boolean;
  items: PickerItem[];
}

/** What a run on screen gives the picker. */
export interface Samples {
  /** Each step's last output, by step name (inside a foreach, the last item's). */
  steps: Record<string, unknown>;
  /** The run's input text, when a run has been started. */
  input?: string;
}

const MAX_DEPTH = 4;
const MAX_ITEMS_PER_GROUP = 60;
const PREVIEW_LENGTH = 48;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key as JSONata writes it after a dot: bare when it is a plain name, in backticks otherwise. */
export function pathKey(key: string): string {
  return IDENTIFIER.test(key) ? key : `\`${key.replace(/`/g, "")}\``;
}

/** One value in a line, for a person to recognise it by: not meant to be parsed. */
export function previewOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (Array.isArray(value)) return `list of ${value.length}`;
  if (typeof value === "object") return "object";
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

/** Every path into a value, breadth-first so the shallow, useful ones survive the cap. A list shows its first item. */
export function flattenPaths(root: string, value: unknown): PickerItem[] {
  const out: PickerItem[] = [{ path: root, preview: previewOf(value) }];
  let level: { path: string; value: unknown }[] = [{ path: root, value }];
  for (let depth = 0; depth < MAX_DEPTH && out.length < MAX_ITEMS_PER_GROUP; depth++) {
    const next: { path: string; value: unknown }[] = [];
    for (const node of level) {
      let children: [string, unknown][] = [];
      if (Array.isArray(node.value)) {
        if (node.value.length > 0) children = [[`${node.path}[0]`, node.value[0]]];
      } else if (typeof node.value === "object" && node.value !== null) {
        children = Object.entries(node.value).map(([k, v]) => [`${node.path}.${pathKey(k)}`, v]);
      }
      for (const [path, child] of children) {
        if (out.length >= MAX_ITEMS_PER_GROUP) break;
        out.push({ path, preview: previewOf(child) });
        next.push({ path, value: child });
      }
    }
    level = next;
  }
  return out;
}

/** The step outputs a tracker holds, by step name. A step that failed or has not finished gives none. */
export function samplesFrom(tracker: RunTracker, input?: string): Samples {
  const steps: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(tracker.entries)) {
    if (entry.outcome === "completed" && entry.output !== undefined) {
      steps[baseStepName(name)] = entry.output;
    }
  }
  return { steps, ...(input !== undefined && { input }) };
}

function fieldItems(root: string, fields: string[]): PickerItem[] {
  return [{ path: root }, ...fields.map((f) => ({ path: `${root}.${pathKey(f)}` }))];
}

/** The groups for one expression field: only what the scope lets that expression read. */
export function pickerGroups(scope: ExpressionScope, samples: Samples): PickerGroup[] {
  if (scope.kind === "item") return [];
  const groups: PickerGroup[] = [];

  // A webhook's `trigger` has no run to sample from before the request arrives, so it lists what it holds.
  const trigger: PickerItem[] = [
    { path: "trigger" },
    { path: "trigger.headers" },
    { path: "trigger.body" },
    ...scope.trigger.map((f) => ({ path: `trigger.${pathKey(f)}` })),
  ];
  if (scope.kind === "ingress") {
    return [
      {
        id: "trigger",
        title: "The request",
        note: "What a webhook call holds.",
        sampled: false,
        items: trigger,
      },
    ];
  }

  for (const local of scope.local ?? []) {
    groups.push({
      id: `local:${local.name}`,
      title: local.name,
      note: "The item the loop is on.",
      sampled: false,
      items: fieldItems(local.name, local.fields),
    });
  }

  // Nearest upstream first: the step just before this one is the likeliest to be wanted.
  for (const step of [...(scope.ready ?? scope.steps)].reverse()) {
    const sample = samples.steps[step.name];
    const known = sample !== undefined;
    groups.push({
      id: `step:${step.name}`,
      title: step.name,
      note: known ? "Values from the last run." : "No value yet; run the workflow to see one.",
      sampled: known,
      items: known ? flattenPaths(step.name, sample) : fieldItems(step.name, step.fields),
    });
  }
  const inputItem: PickerItem = {
    path: "input",
    ...(samples.input !== undefined &&
      samples.input !== "" && { preview: previewOf(samples.input) }),
  };
  groups.push({
    id: "input",
    title: "The run's input",
    note: "The text typed in Test Run.",
    sampled: inputItem.preview !== undefined,
    items: [inputItem],
  });

  if (scope.vars.length > 0) {
    groups.push({
      id: "vars",
      title: "Vars",
      note: "The spec's vars.",
      sampled: false,
      items: scope.vars.map((v) => ({ path: `vars.${pathKey(v.name)}`, preview: v.detail })),
    });
  }

  groups.push({
    id: "trigger",
    title: "What started the run",
    note: "The trigger's fields.",
    sampled: false,
    items: trigger,
  });

  return groups;
}

/** The text to put in a field: a bare reference in an expression, or wrapped in braces inside a prompt. */
export function referenceText(path: string, wrap: boolean): string {
  return wrap ? `{{ ${path} }}` : path;
}
