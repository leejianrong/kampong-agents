import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentCatalogEntry } from "@kampong/spec";
import { ToolForm } from "../../src/ToolForm.js";

// KAN-1885: the Component kind builds its fields from the chosen op's input schema.

const TICKETS: ComponentCatalogEntry = {
  id: "acme/tickets",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  permissionsSummary: "reach tickets.example.test",
  title: "Tickets",
  slots: [{ name: "token", env: "TICKETS_TOKEN" }],
  config: [{ name: "region", default: "eu", description: "Data region", required: false }],
  ops: {
    create: {
      title: "Create a ticket",
      effect: "write",
      input: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title", description: "Short summary" },
          body: { type: "string", format: "multiline" },
          priority: { type: "integer", default: 3 },
          urgent: { type: "boolean" },
          level: { type: "string", enum: ["low", "high"], default: "low" },
          labels: { type: "array", items: { type: "string" } },
          owner: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, team: { type: "string" } },
          },
        },
      },
    },
    purge: { effect: "destructive", title: "Purge everything" },
    import: {
      effect: "write",
      input: {
        type: "object",
        properties: { rows: { type: "array", items: { type: "object" } } },
      },
    },
  },
};

function open(props: Partial<React.ComponentProps<typeof ToolForm>> = {}) {
  const onSubmit = vi.fn();
  render(<ToolForm components={[TICKETS]} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Component" }));
  return onSubmit;
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

describe("Component kind", () => {
  afterEach(() => cleanup());

  it("is offered only when the server provides components", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Component" })).toBeNull();
  });

  it("says so, and why, when nothing is installed", () => {
    render(
      <ToolForm
        components={[]}
        componentProblems={["oops: acme/x@1.0.0 must live at acme/x/1.0.0"]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Component" }));
    expect(screen.getByRole("status").textContent).toMatch(/No components are installed/);
    expect(screen.getByText(/must live at acme\/x\/1\.0\.0/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Tool" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("generates a field for each input property, with labels, hints and defaults", () => {
    open();
    expect(screen.getByLabelText(/Title/)).toBeTruthy();
    expect(screen.getByText("Short summary")).toBeTruthy();
    expect((screen.getByLabelText("body") as HTMLElement).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("priority").getAttribute("placeholder")).toBe("Default: 3");
    expect((screen.getByLabelText("urgent") as HTMLInputElement).type).toBe("checkbox");
    expect((screen.getByLabelText("level") as HTMLSelectElement).value).toBe("low");
    expect(screen.getByLabelText("labels").getAttribute("placeholder")).toBe("One per line");
    expect(screen.getByLabelText(/^name/)).toBeTruthy();
    expect(screen.getByLabelText("Config: region")).toBeTruthy();
    expect(screen.getByText("Data region")).toBeTruthy();
    expect(screen.getByLabelText("Secret: token (env reference)").getAttribute("placeholder")).toBe(
      "${TICKETS_TOKEN}",
    );
  });

  it("builds a component tool from the generated fields, typed to the schema", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "make_ticket" } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Broken login" } });
    fireEvent.change(screen.getByLabelText("priority"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("urgent"));
    fireEvent.change(screen.getByLabelText("level"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("labels"), { target: { value: "bug\nlogin\n" } });
    fireEvent.change(screen.getByLabelText(/^name/), { target: { value: "Kai" } });
    fireEvent.change(screen.getByLabelText("Secret: token (env reference)"), {
      target: { value: "${MY_TOKEN}" },
    });
    fireEvent.change(screen.getByLabelText("Config: region"), { target: { value: "us" } });
    save();
    expect(onSubmit).toHaveBeenCalledWith({
      name: "make_ticket",
      action: "component",
      use: "acme/tickets@1.0.0",
      op: "create",
      with: {
        title: "Broken login",
        priority: 1,
        urgent: true,
        level: "high",
        labels: ["bug", "login"],
        owner: { name: "Kai" },
      },
      config: { region: "us" },
      secrets: { token: "${MY_TOKEN}" },
    });
  });

  it("omits fields left empty and keeps the spec minimal", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "x" } });
    save();
    expect(onSubmit).toHaveBeenCalledWith({
      name: "t",
      action: "component",
      use: "acme/tickets@1.0.0",
      op: "create",
      with: { title: "x" },
    });
  });

  it("shows every problem and does not submit: a missing required field, a bad number, a literal secret", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText("priority"), { target: { value: "lots" } });
    save();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Title is required");
    expect(alert.textContent).toContain("priority must be a number");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("priority"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Secret: token (env reference)"), {
      target: { value: "xoxb-literal" },
    });
    save();
    expect(screen.getByRole("alert").textContent).toMatch(/environment variable/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("explains the approval default from the operation's effect and lets it be overridden", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "purge" } });
    expect(screen.getByText(/Destructive\. Asks a person to approve/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "wipe" } });
    fireEvent.change(screen.getByLabelText("Approval"), { target: { value: "never" } });
    save();
    expect(onSubmit).toHaveBeenCalledWith({
      name: "wipe",
      action: "component",
      use: "acme/tickets@1.0.0",
      op: "purge",
      requires_approval: false,
    });
  });

  it("falls back to a YAML input for an op the form cannot express, and says why", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "import" } });
    expect(screen.getByRole("note").textContent).toMatch(/rows/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "imp" } });
    fireEvent.change(screen.getByLabelText("Input (YAML)"), {
      target: { value: "rows:\n  - a: 1\n" },
    });
    save();
    expect(onSubmit).toHaveBeenCalledWith({
      name: "imp",
      action: "component",
      use: "acme/tickets@1.0.0",
      op: "import",
      with: { rows: [{ a: 1 }] },
    });
  });

  it("reports invalid YAML in the fallback instead of submitting", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "import" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "imp" } });
    fireEvent.change(screen.getByLabelText("Input (YAML)"), {
      target: { value: "- just\n- a list" },
    });
    save();
    expect(screen.getByRole("alert").textContent).toMatch(/mapping/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts a typed reference to an earlier step's output into the focused field", () => {
    const onSubmit = open({
      references: [{ reference: "{{ fetch.status }}", label: "fetch.status (string)" }],
    });
    const picker = screen.getByLabelText("Insert reference") as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "t" } });
    const title = screen.getByLabelText(/Title/);
    fireEvent.focus(title);
    expect(picker.disabled).toBe(false);
    fireEvent.change(picker, { target: { value: "{{ fetch.status }}" } });
    expect((title as HTMLInputElement).value).toBe("{{ fetch.status }}");
    save();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ with: { title: "{{ fetch.status }}" } }),
    );
  });

  it("resets the generated fields when the operation changes", () => {
    open();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "keep?" } });
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "purge" } });
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "create" } });
    expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe("");
  });

  it("scopes the object fields in a group named for the object", () => {
    open();
    const group = screen.getByRole("group", { name: /owner/ });
    expect(within(group).getByLabelText(/name/)).toBeTruthy();
    expect(within(group).getByLabelText("team")).toBeTruthy();
  });

  it("reminds the author to pin the component, since a run refuses an unpinned one", () => {
    open();
    expect(screen.getByText(/kampong lock/)).toBeTruthy();
  });

  it("starts from the first installed component even when the list arrives after the form opened", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ToolForm components={[]} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Component" }));
    rerender(<ToolForm components={[TICKETS]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect((screen.getByLabelText("Component") as HTMLSelectElement).value).toBe(
      "acme/tickets@1.0.0",
    );
    expect((screen.getByLabelText("Operation") as HTMLSelectElement).value).toBe("create");
  });

  it("shows a placeholder for a required choice with no default, and asks for it when it is left alone", () => {
    const onSubmit = vi.fn();
    const withEnum: ComponentCatalogEntry = {
      ...TICKETS,
      ops: {
        pick: {
          effect: "read",
          input: {
            type: "object",
            required: ["mode"],
            properties: { mode: { type: "string", enum: ["a", "b"] } },
          },
        },
      },
    };
    render(<ToolForm components={[withEnum]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Component" }));
    const select = screen.getByLabelText(/^mode/) as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "t" } });
    save();
    expect(screen.getByRole("alert").textContent).toContain("mode is required");
    fireEvent.change(select, { target: { value: "b" } });
    save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ with: { mode: "b" } }));
  });

  it("disables Insert reference once the focused field is gone", () => {
    open({ references: [{ reference: "{{ s.x }}", label: "s.x (string)" }] });
    fireEvent.focus(screen.getByLabelText(/Title/));
    const picker = screen.getByLabelText("Insert reference") as HTMLSelectElement;
    expect(picker.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "purge" } });
    expect(
      (screen.queryByLabelText("Insert reference") as HTMLSelectElement | null)?.disabled ?? true,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "create" } });
    expect((screen.getByLabelText("Insert reference") as HTMLSelectElement).disabled).toBe(true);
  });

  it("requires a config value that has no default", () => {
    const needsConfig: ComponentCatalogEntry = {
      ...TICKETS,
      config: [{ name: "project", required: true }],
    };
    const onSubmit = vi.fn();
    render(<ToolForm components={[needsConfig]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Component" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "x" } });
    save();
    expect(screen.getByRole("alert").textContent).toContain("project is required");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Config: project/), { target: { value: "p1" } });
    save();
    expect(onSubmit).toHaveBeenCalled();
  });
});
