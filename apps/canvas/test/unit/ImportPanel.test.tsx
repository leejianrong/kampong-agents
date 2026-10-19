import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPanel } from "../../src/ImportPanel.js";
import { YamlPreview } from "../../src/YamlPreview.js";
import type { ApplyOpsResponse } from "../../src/api.js";

// KAM-207: import a spec from a file, and the quiet Download / Import actions on the YAML view.

const VALID = `version: "1.0"
agent:
  id: a
  name: Imported agent
  role: R
  goal: G
  workflow:
    - step: one
      action: x
`;

function file(text: string, name = "spec.yaml") {
  const f = new File([text], name, { type: "text/yaml" });
  // jsdom's File has no text() in every version.
  if (!f.text) Object.defineProperty(f, "text", { value: async () => text });
  return f;
}

function setup(
  options: { hasContent?: boolean; hosted?: boolean; response?: ApplyOpsResponse } = {},
) {
  const replace = vi.fn(
    async (_text: string): Promise<ApplyOpsResponse> => options.response ?? { success: true },
  );
  const onImported = vi.fn();
  render(
    <ImportPanel
      hasContent={options.hasContent ?? true}
      hosted={options.hosted ?? false}
      replace={replace}
      onImported={onImported}
    />,
  );
  const choose = async (text: string, name?: string) => {
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file(text, name)] } });
  };
  return { replace, onImported, choose };
}

describe("ImportPanel", () => {
  afterEach(cleanup);

  it("shows line-numbered errors for an invalid file and sends nothing", async () => {
    const { replace, choose } = setup();
    await choose(VALID.replace("id: a", "id: [unclosed"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was changed");
    expect(alert.textContent).toMatch(/Line \d+:/);
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("asks before replacing a spec that has content, then imports", async () => {
    const { replace, onImported, choose } = setup();
    await choose(VALID, "mine.yaml");
    await screen.findByText(/mine.yaml is valid \(Imported agent: 1 step, 0 tools\)/);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Replace the current spec?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace the current spec" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith(VALID);
  });

  it("Cancel in the confirm sends nothing", async () => {
    const { replace, choose } = setup();
    await choose(VALID);
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Replace the current spec?" })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("imports straight away into an empty spec", async () => {
    const { replace, choose } = setup({ hasContent: false });
    await choose(VALID);
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(VALID));
  });

  it("shows the server's refusal with its line, and stays open", async () => {
    const { onImported, choose } = setup({
      hasContent: false,
      response: { success: false, errors: [{ path: [], message: "bad thing", line: 7 }] },
    });
    await choose(VALID);
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Line 7: bad thing");
    expect(onImported).not.toHaveBeenCalled();
  });

  it("notes that comments may not survive, in the hosted product only", () => {
    setup({ hosted: true });
    expect(screen.getByRole("note").textContent).toContain("Comments in the file may not be kept");
    cleanup();
    setup({ hosted: false });
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("YamlPreview actions", () => {
  afterEach(cleanup);

  it("offers Download as file and Import from file, and neither when the host gives no handler", () => {
    const onDownload = vi.fn();
    const onImport = vi.fn();
    render(<YamlPreview source="x" onDownload={onDownload} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Download as file" }));
    fireEvent.click(screen.getByRole("button", { name: "Import from file" }));
    expect(onDownload).toHaveBeenCalled();
    expect(onImport).toHaveBeenCalled();
    cleanup();
    render(<YamlPreview source="x" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
