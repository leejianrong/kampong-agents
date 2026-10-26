import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, RunEventMessage, RunMode, RunOptionsResponse, RunState } from "./api.js";
import { applyMessage, emptyTracker, type RunTracker } from "./runStatus.js";
import type { RunTrackerApi } from "./runTracker.js";

// Everything the Run bar and the Test Run panel share (KAM-219): the mode, the input and var fields, the runs of
// this browser session and the one on show. It lives in the app, above both, so closing a panel, opening Secrets
// or switching to another panel never costs the run on screen or what was typed. The run bar starts runs; the
// panel shows the details; the canvas reads the tracker (KAM-190) that this hands each run's stream to.

/** One run of this session: what started it, and what it did. */
export interface RunEntry {
  id: string;
  /** The mode the run was started in (KAM-188), as the server reported it; absent from a server with only live runs. */
  mode?: RunMode;
  input: string;
  startedAt: number;
  /** Set when the run is over (this browser's clock). */
  endedAt?: number;
  state: RunState;
  /** This run's own record of its stream, so an earlier run can be shown again with its per-step data. */
  tracker: RunTracker;
}

export const MAX_RUNS = 20;

const isOver = (state: RunState) =>
  state.status === "completed" || state.status === "failed" || state.status === "rejected";

type RunTools = NonNullable<RunOptionsResponse["tools"]>;
type RunVars = NonNullable<RunOptionsResponse["vars"]>;

export interface RunSession {
  options: RunOptionsResponse | null;
  /** Until the options arrive the mode is a guess, so no run may start. */
  optionsPending: boolean;
  mode: RunMode;
  setMode: (mode: RunMode) => void;
  /** Both modes are open to this spec. */
  canChoose: boolean;
  sideEffecting: RunTools;
  declaredVars: RunVars;
  input: string;
  setInput: (value: string) => void;
  varText: Record<string, string>;
  setVarText: (update: (previous: Record<string, string>) => Record<string, string>) => void;
  confirmingLive: boolean;
  cancelLive: () => void;
  /** Why a run could not start (the server's words). */
  error: string | null;
  /** Why a run cannot start right now, from the spec. */
  blockedReason: string | undefined;
  /** Most recent first. */
  runs: RunEntry[];
  /** The run on show: the one picked in the drawer, else the latest. */
  viewed: RunEntry | null;
  /** The latest run, which the engine may still be running. */
  latest: RunEntry | null;
  viewRun: (id: string) => void;
  isRunning: boolean;
  canRun: boolean;
  /** Run, asking first when a live run could change something outside the project. */
  requestRun: () => void;
  /** Run now, past the live confirmation. */
  start: () => Promise<void>;
  /** A Replay run (recorded fixtures, nothing sent), whatever mode is chosen; null when this spec has no fixtures or a run is on. */
  replayNow: (() => void) | null;
  decide: (approved: boolean, reason?: string) => Promise<void>;
}

export function useRunSession(
  api: ApiClient,
  tracker: RunTrackerApi,
  config: { blockedReason?: string | undefined; refreshKey?: unknown } = {},
): RunSession {
  const [input, setInput] = useState("");
  const [options, setOptions] = useState<RunOptionsResponse | null>(null);
  const [optionsPending, setOptionsPending] = useState(() => api.getRunOptions !== undefined);
  const [mode, setModeState] = useState<RunMode>("live");
  // Whether the person has picked a mode (KAM-205): until they have, the bar follows what the spec offers by default.
  const picked = useRef(false);
  const setMode = (next: RunMode) => {
    picked.current = true;
    setModeState(next);
  };
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [varText, setVarTextState] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  // What the options last said each var defaulted to, so a refetch keeps what was typed and resets the rest.
  const defaultsRef = useRef<Record<string, string>>({});

  // Closes the SSE subscription on unmount too, not just on the next start.
  useEffect(() => () => unsubscribeRef.current?.(), []);

  // Loaded once, and again when the spec's text changes (a template chosen, fixtures or vars added), so the
  // default mode and the var fields follow the spec the bar is about to run.
  useEffect(() => {
    if (!api.getRunOptions) return;
    let cancelled = false;
    setOptionsPending(true);
    void (async () => {
      try {
        const loaded = await api.getRunOptions?.();
        if (cancelled) return;
        if (!loaded?.success) {
          setOptions(null);
          return;
        }
        setOptions(loaded);
        const declared = loaded.vars ?? [];
        const before = defaultsRef.current;
        defaultsRef.current = Object.fromEntries(declared.map((v) => [v.name, v.default ?? ""]));
        setVarTextState((previous) =>
          Object.fromEntries(
            declared.map((v) => {
              const typed = previous[v.name];
              const untouched = typed === undefined || typed === (before[v.name] ?? "");
              return [v.name, untouched ? (v.default ?? "") : typed];
            }),
          ),
        );
        // The spec's default, unless the person chose a mode and it is still open to the spec. A workflow that was
        // live only (it had a model step) and is now replayable moves to Replay on its own.
        setModeState((current) =>
          picked.current && loaded.modes?.includes(current)
            ? current
            : (loaded.defaultMode ?? "live"),
        );
      } catch {
        // A server that cannot describe its runs gets the plain bar: no switch, a live run as before.
      } finally {
        if (!cancelled) setOptionsPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, config.refreshKey]);

  const sideEffecting = (options?.tools ?? []).filter((t) => t.sideEffecting);
  const declaredVars = options?.vars ?? [];
  const canChoose = (options?.modes?.length ?? 0) > 1;

  const latest = runs[0] ?? null;
  const viewed = (viewedId !== null ? runs.find((r) => r.id === viewedId) : undefined) ?? latest;
  const isRunning =
    starting || latest?.state.status === "running" || latest?.state.status === "awaiting_approval";
  const blockedReason = config.blockedReason;
  const canRun = !isRunning && !optionsPending && blockedReason === undefined;

  const update = useCallback((id: string, message: RunEventMessage) => {
    const now = Date.now();
    setRuns((list) =>
      list.map((r) =>
        r.id !== id
          ? r
          : {
              ...r,
              state: message.state,
              tracker: applyMessage(r.tracker, id, message, now),
              ...(r.endedAt === undefined && isOver(message.state) && { endedAt: now }),
            },
      ),
    );
  }, []);

  async function start(forced?: RunMode) {
    setConfirmingLive(false);
    if (starting) return;
    // Set synchronously, before the `await` below, so a fast double-click can't get past this guard twice and
    // start two concurrent runs.
    setStarting(true);
    setError(null);
    // The last run's marks leave the canvas as the next one starts.
    trackerRef.current.begin(null);
    try {
      // Only the vars changed from their defaults go with the run; the rest keep resolving as the spec says.
      const changed = Object.fromEntries(
        declaredVars
          .filter((v) => (varText[v.name] ?? "") !== (v.default ?? ""))
          .map((v) => [v.name, varText[v.name] ?? ""]),
      );
      const result =
        Object.keys(changed).length > 0
          ? await api.startRun(input, options ? (forced ?? mode) : undefined, changed)
          : await api.startRun(input, options ? (forced ?? mode) : undefined);
      if (!result.success || !result.id || !result.state) {
        setError(result.error ?? "Failed to start run.");
        return;
      }
      const id = result.id;
      const now = Date.now();
      const entry: RunEntry = {
        id,
        ...(result.mode && { mode: result.mode }),
        input,
        startedAt: now,
        ...(isOver(result.state) && { endedAt: now }),
        state: result.state,
        tracker: { ...emptyTracker, runId: id },
      };
      setRuns((list) => [entry, ...list].slice(0, MAX_RUNS));
      setViewedId(null);
      trackerRef.current.begin(id);
      const first: RunEventMessage = { type: "state", state: result.state };
      trackerRef.current.publish(id, first);
      update(id, first);

      unsubscribeRef.current?.();
      unsubscribeRef.current = api.subscribeToRunEvents(id, (message) => {
        update(id, message);
        trackerRef.current.publish(id, message);
      });
    } finally {
      setStarting(false);
    }
  }

  function requestRun() {
    if (!canRun) return;
    // A live run that can change something outside the project asks first, naming what it would call.
    if (options && mode === "live" && sideEffecting.length > 0) {
      setConfirmingLive(true);
      return;
    }
    void start();
  }

  async function decide(approved: boolean, reason?: string) {
    if (!latest) return;
    const id = latest.id;
    const result = await api.approveRun(id, approved, reason);
    if (result.success && result.state) {
      const message: RunEventMessage = { type: "state", state: result.state };
      update(id, message);
      trackerRef.current.publish(id, message);
    } else {
      setError(result.error ?? "Failed to record approval decision.");
    }
  }

  function viewRun(id: string) {
    const entry = runs.find((r) => r.id === id);
    if (!entry) return;
    setViewedId(id === latest?.id ? null : id);
    trackerRef.current.show(entry.tracker);
  }

  return {
    options,
    optionsPending,
    mode,
    setMode,
    canChoose,
    sideEffecting,
    declaredVars,
    input,
    setInput,
    varText,
    setVarText: (fn) => setVarTextState(fn),
    confirmingLive,
    cancelLive: () => setConfirmingLive(false),
    error,
    blockedReason,
    runs,
    viewed,
    latest,
    viewRun,
    isRunning,
    canRun,
    requestRun,
    start,
    replayNow:
      canRun && options?.modes?.includes("replay")
        ? () => {
            setMode("replay");
            void start("replay");
          }
        : null,
    decide,
  };
}
