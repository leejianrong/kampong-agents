// Poll trigger core (KAM-117, ADR-0050): given the list a connector op returned, decides which items are new
// and starts a run for each, remembering them in the StateStore so a restart never reprocesses one. It knows
// nothing about connectors or runs: the caller supplies the fetched result and a `start` function.
//
// Dedupe is a declared enum over persisted state, never user code:
//  - `unique`: a key is new if it was never seen. One entry per key, kept forever.
//  - `time_window`: a key is new if it was not seen within the window. The entry expires with the window.
//  - `greatest`: a key is new if it is above the highest key started so far (numbers by value, strings by
//    code unit). Items start in ascending key order, so the cursor only ever moves forward.
//  - `last`: the list is oldest first; an item is new if it comes after the item that was last in the
//    previous poll's start order. If that item is no longer in the list, every item is new.
//
// A key is remembered only once its run has started: if `start` throws, the claim is released (unique,
// time_window) or the cursor stays put (greatest, last), the error propagates so the runner reports the
// failure, and the same item is offered again on the next poll. A crash between starting a run and
// remembering it can repeat that one item; nothing is ever silently dropped.

import { createHash } from "node:crypto";
import type { PollDedupe } from "@kampong/spec";
import { evaluateExpression } from "./expressions.js";
import type { StateStore } from "./state-store.js";

export interface PollConfig {
  /** Namespaces the persisted keys; one name per served spec. */
  name: string;
  dedupe: PollDedupe;
  /** Expression over one item giving its key (a string or a number). */
  id: string;
  /** Expression over the op's result selecting the list. Without it, the result itself is the list. */
  items?: string;
  /** How long a key stays seen under `time_window`. */
  windowMs?: number;
  /** False starts a single run over all the new items. Default true. */
  oneRunPerItem?: boolean;
}

export interface PollOutcome {
  /** Items the op returned. */
  fetched: number;
  /** Items new this poll (each started in one run, or all in one). */
  started: number;
  /** Runs started. */
  runs: number;
}

type Key = string | number;

export const pollKey = (name: string, ...parts: string[]): string =>
  ["poll", name, ...parts].join(":");

const digest = (key: Key): string =>
  createHash("sha256")
    .update(`${typeof key}:${key}`)
    .digest("hex");

const describe = (value: unknown): string => {
  const text =
    typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

async function selectItems(result: unknown, items: string | undefined): Promise<unknown[]> {
  const selected = items === undefined ? result : await evaluateExpression(items, result);
  if (selected === undefined || selected === null) return [];
  if (Array.isArray(selected)) return selected;
  // JSONata hands back a lone match as the value itself, not a one-item list, so a result with a single
  // message would otherwise be refused. Without `items` there is no such excuse: the op returned a non-list.
  if (items !== undefined) return [selected];
  throw new Error(
    `poll: the op returned ${describe(result)}, not a list; set items to an expression that selects the list`,
  );
}

async function keyOf(item: unknown, index: number, id: string): Promise<Key> {
  const key = await evaluateExpression(id, item);
  if (
    (typeof key === "string" && key !== "") ||
    (typeof key === "number" && Number.isFinite(key))
  ) {
    return key;
  }
  throw new Error(
    `poll: id gave ${describe(key)} for item ${index} (${describe(item)}); an id must be a non-empty string or a number`,
  );
}

const compare = (a: Key, b: Key): number => {
  if (typeof a !== typeof b) {
    throw new Error(
      `poll: dedupe greatest compares ids of one kind, but saw ${describe(a)} and ${describe(b)}`,
    );
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

export interface PollInput {
  store: StateStore;
  config: PollConfig;
  /** What the connector op returned. */
  result: unknown;
  /** Starts a run over `batch`: one item, or all the new ones when `oneRunPerItem` is false. */
  start(batch: unknown[]): Promise<void>;
}

export async function processPoll({
  store,
  config,
  result,
  start,
}: PollInput): Promise<PollOutcome> {
  const { name, dedupe } = config;
  const batchMode = config.oneRunPerItem === false;
  const items = await selectItems(result, config.items);
  const keyed: { item: unknown; key: Key }[] = [];
  for (const [index, item] of items.entries()) {
    keyed.push({ item, key: await keyOf(item, index, config.id) });
  }
  const outcome: PollOutcome = { fetched: items.length, started: 0, runs: 0 };

  if (dedupe === "unique" || dedupe === "time_window") {
    const ttlMs = dedupe === "time_window" ? config.windowMs : undefined;
    if (dedupe === "time_window" && !(ttlMs && ttlMs > 0)) {
      throw new Error("poll: dedupe time_window needs a window");
    }
    const claimed: { item: unknown; storeKey: string }[] = [];
    const release = async (list: { storeKey: string }[]) => {
      for (const c of list) await store.delete(c.storeKey).catch(() => {});
    };
    for (const { item, key } of keyed) {
      const storeKey = pollKey(name, "seen", digest(key));
      const won = await store.putIfAbsent(
        storeKey,
        { at: Date.now() },
        ttlMs === undefined ? undefined : { ttlMs },
      );
      if (!won) continue;
      if (batchMode) {
        claimed.push({ item, storeKey });
        continue;
      }
      try {
        await start([item]);
      } catch (error) {
        await release([{ storeKey }]);
        throw error;
      }
      outcome.started++;
      outcome.runs++;
    }
    if (batchMode && claimed.length > 0) {
      try {
        await start(claimed.map((c) => c.item));
      } catch (error) {
        await release(claimed);
        throw error;
      }
      outcome.started = claimed.length;
      outcome.runs = 1;
    }
    return outcome;
  }

  const cursorKey = pollKey(name, "cursor");
  const cursor = (await store.get<{ key: Key }>(cursorKey))?.key;
  let fresh: { item: unknown; key: Key }[];
  if (dedupe === "greatest") {
    fresh = keyed.filter((k) => cursor === undefined || compare(k.key, cursor) > 0);
    fresh.sort((a, b) => compare(a.key, b.key));
  } else {
    // `last`: whatever follows the remembered key; an unknown key (or none yet) means everything is new.
    const at = cursor === undefined ? -1 : keyed.map((k) => k.key).lastIndexOf(cursor);
    fresh = keyed.slice(at + 1);
  }
  if (batchMode) {
    if (fresh.length === 0) return outcome;
    await start(fresh.map((f) => f.item));
    await store.put(cursorKey, { key: fresh[fresh.length - 1]!.key });
    return { ...outcome, started: fresh.length, runs: 1 };
  }
  for (const { item, key } of fresh) {
    await start([item]);
    await store.put(cursorKey, { key });
    outcome.started++;
    outcome.runs++;
  }
  return outcome;
}
