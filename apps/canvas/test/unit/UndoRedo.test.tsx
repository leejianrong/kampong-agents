import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";

// KAM-183 (ADR-0062): Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y and the toast's Undo link restore the file; an edit made outside
// the canvas clears the history with a notice; a text field keeps its own undo.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const ORIGINAL = `# a comment that must survive
version: "1.1"
agent:
  id: greeter
  name: Greeter
  role: Front desk
  goal: Greet visitors.   # trailing note
  workflow:
    - step: greet
      action: say_hello
`;
const EDITED = ORIGINAL.replace("say_hello", "say_goodbye");
const THIRD = ORIGINAL.replace("say_hello", "say_third");

const specOf = (action: string) => ({
  version: "1.1",
  agent: {
    id: "greeter",
    name: "Greeter",
    role: "Front desk",
    goal: "Greet visitors.",
    workflow: [{ step: "greet", action }],
  },
});

function setup(options: { staleOnRestore?: boolean; echoWrites?: boolean } = {}) {
  let source = ORIGINAL;
  let revision = 1;
  let edits = 0;
  let emit: (event: { type: string; source: string }) => void = () => {};
  const replaceSource = vi.fn(async (text: string, opts?: { baseRevision?: string }) => {
    if (options.staleOnRestore || (opts?.baseRevision && opts.baseRevision !== `r${revision}`)) {
      return { success: false, stale: true, errors: [{ path: [], message: "stale" }] };
    }
    source = text;
    revision++;
    if (options.echoWrites) emit({ type: "reload", source });
    return { success: true, revision: `r${revision}` };
  });
  const api = {
    loadSpec: async () => ({
      success: true,
      spec: specOf(/action: (\w+)/.exec(source)![1]!),
      errors: [],
      layout: {},
      source,
    }),
    applyPatch: async () => {
      source = edits++ === 0 ? EDITED : THIRD;
      revision++;
      if (options.echoWrites) emit({ type: "conflict", source });
      return { success: true, revision: `r${revision}` };
    },
    applyOps: async () => ({ success: true }),
    replaceSource,
    pinPositions: async () => ({ success: true }),
    subscribeToEvents: (cb: (event: { type: string; source: string }) => void) => {
      emit = cb;
      return () => {};
    },
    startRun: async () => ({ success: true }),
    approveRun: async () => ({ success: true }),
    subscribeToRunEvents: () => () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<App api={api as any} />);
  return {
    replaceSource,
    emit: (e: { type: string; source: string }) => emit(e),
    file: () => source,
  };
}

const ready = () => waitFor(() => expect(screen.getByText("greet")).toBeTruthy());
const toast = () => screen.getByTestId("save-toast");

async function saveAVar() {
  fireEvent.click(screen.getByRole("button", { name: /^Vars/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add var" }));
  fireEvent.input(screen.getByLabelText("Name", { exact: false }), {
    target: { value: "symbols" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save var" }));
  await waitFor(() => expect(toast().textContent).toMatch(/^Saved/));
}

describe("undo and redo (KAM-183)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("Ctrl+Z restores the previous text byte for byte, comments included; Ctrl+Shift+Z and Ctrl+Y redo it", async () => {
    const { replaceSource, file } = setup();
    await ready();
    await saveAVar();
    expect(file()).toBe(EDITED);

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Undone/));
    expect(file()).toBe(ORIGINAL);
    expect(replaceSource).toHaveBeenLastCalledWith(ORIGINAL, { baseRevision: "r2" });

    fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Redone/));
    expect(file()).toBe(EDITED);

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(file()).toBe(ORIGINAL));
    await waitFor(() => expect(toast().textContent).toMatch(/^Undone/));
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() => expect(file()).toBe(EDITED));
  });

  it("the Undo link in the Saved toast restores the file", async () => {
    const { file } = setup();
    await ready();
    await saveAVar();
    fireEvent.click(screen.getByTestId("toast-action"));
    await waitFor(() => expect(file()).toBe(ORIGINAL));
    expect(toast().textContent).toMatch(/^Undone/);
    expect(screen.getByTestId("toast-action").textContent).toBe("Redo");
  });

  it("says so, and writes nothing, when there is nothing to undo", async () => {
    const { replaceSource } = setup();
    await ready();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toBe("Nothing to undo."));
    expect(replaceSource).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+Z to a text field being typed in", async () => {
    const { replaceSource, file } = setup();
    await ready();
    await saveAVar();
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    const field = screen.getByLabelText("Name", { exact: false });
    const proceeded = fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(proceeded).toBe(true); // not preventDefault-ed: the browser's own text undo runs
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(replaceSource).not.toHaveBeenCalled();
    expect(file()).toBe(EDITED);
  });

  it("is listed in the menu, disabled with nothing to undo, and enabled after an edit", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const undo = () => screen.getByRole("menuitem", { name: /^Undo/ });
    expect(undo().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: /^Redo/ }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await saveAVar();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(undo().getAttribute("aria-disabled")).toBeNull();
  });

  it("an edit made outside the canvas clears the history with a notice", async () => {
    const { emit, replaceSource } = setup();
    await ready();
    await saveAVar();
    // Past the moment in which a change is taken for the canvas's own echo.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    act(() => emit({ type: "reload", source: "# someone else\n" + ORIGINAL }));
    await waitFor(() => expect(toast().textContent).toMatch(/outside the canvas/));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toBe("Nothing to undo."));
    expect(replaceSource).not.toHaveBeenCalled();
  });

  it("the watcher reporting the canvas's own save or undo before it has reloaded does not clear the history", async () => {
    const { file } = setup({ echoWrites: true });
    await ready();
    await saveAVar();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Undone/));
    expect(file()).toBe(ORIGINAL);
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Redone/));
    expect(file()).toBe(EDITED);
  });

  it("two edits then two undos, with the watcher echoing each restore: the older entry is still there", async () => {
    const { file } = setup({ echoWrites: true });
    await ready();
    await saveAVar();
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    fireEvent.input(screen.getByLabelText("Name", { exact: false }), { target: { value: "more" } });
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() => expect(file()).toBe(THIRD));
    await waitFor(() => expect(screen.getByTestId("toast-action")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(file()).toBe(EDITED));
    await waitFor(() => expect(screen.getByTestId("toast-action").textContent).toBe("Redo"));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(file()).toBe(ORIGINAL));
  });

  it("the same, with the report arriving after the save", async () => {
    const { emit, file } = setup();
    await ready();
    await saveAVar();
    // The echo arrives before the screen has reloaded the save, as a reload or as a conflict.
    act(() => emit({ type: "reload", source: EDITED }));
    act(() => emit({ type: "conflict", source: EDITED }));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Undone/));
    expect(file()).toBe(ORIGINAL);
    act(() => emit({ type: "reload", source: ORIGINAL }));
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/^Redone/));
    expect(file()).toBe(EDITED);
  });

  it("works on a layout where the letter is not Z but the key is (event.code)", async () => {
    const { file } = setup();
    await ready();
    await saveAVar();
    fireEvent.keyDown(document.body, { key: "я", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(file()).toBe(ORIGINAL));
  });

  it("will not undo under a form with typed input that is not saved", async () => {
    const { replaceSource } = setup();
    await ready();
    await saveAVar();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add tool" }));
    fireEvent.input(screen.getAllByRole("textbox")[0]!, { target: { value: "half" } });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toBe("Finish or discard the open form first."));
    expect(replaceSource).not.toHaveBeenCalled();
  });

  it("keeps the toast with the Undo link up while the pointer is on it", async () => {
    setup();
    await ready();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await saveAVar();
      const link = screen.getByTestId("toast-action");
      fireEvent.mouseEnter(link);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(screen.getByTestId("toast-action")).toBeTruthy();
      fireEvent.mouseLeave(link);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      expect(toast().textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to undo over a change made since (stale), clears the history, and says so", async () => {
    const { replaceSource, file } = setup({ staleOnRestore: true });
    await ready();
    await saveAVar();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toMatch(/left it as it is/));
    expect(replaceSource).toHaveBeenCalledTimes(1);
    expect(file()).toBe(EDITED);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(toast().textContent).toBe("Nothing to undo."));
  });
});
