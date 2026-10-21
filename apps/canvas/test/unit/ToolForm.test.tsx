import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolForm } from "../../src/ToolForm.js";

// KAN-1430 (ADR-0021): the "Add Tool" form now builds the generic HTTP tool
// (default) plus the Slack/Gmail connectors via the "Tool kind" control.

describe("ToolForm", () => {
  afterEach(() => cleanup());

  it("defaults to the HTTP kind and builds an http_request tool", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "get_order" } });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://api.example.com/orders/{{ classify.order_id }}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "get_order",
      action: "http_request",
      method: "GET",
      url: "https://api.example.com/orders/{{ classify.order_id }}",
    });
  });

  it("switches to the Slack kind and builds a slack_post_message connector", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(screen.queryByLabelText("URL")).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "notify_support" } });
    fireEvent.change(screen.getByLabelText("Token (env reference)"), {
      target: { value: "${SLACK_BOT_TOKEN}" },
    });
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "#support" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "{{ draft.text }}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "notify_support",
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#support",
      text: "{{ draft.text }}",
    });
  });

  it("shows a validation error when a connector token is a literal, not ${ENV}", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "notify" } });
    fireEvent.change(screen.getByLabelText("Token (env reference)"), {
      target: { value: "xoxb-real" },
    });
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "#c" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).not.toHaveBeenCalled();
    // The schema's own words, beside the field they are about.
    expect(screen.getByTestId("tool-error-token").textContent).toMatch(/^Problem: /);
  });
});

// KAN-1845: the HTTP kind gains headers, query, a body and a response mode.
describe("ToolForm -- HTTP request fields (KAN-1845)", () => {
  afterEach(() => cleanup());

  function fillBasics() {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fetch_prices" } });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://api.example.test/query" },
    });
  }

  it("builds headers, query, a json body and a response mode from the form", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillBasics();
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "POST" } });
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "Authorization: Bearer ${API_TOKEN}\nAccept: application/json" },
    });
    fireEvent.change(screen.getByLabelText("Query parameters"), {
      target: { value: "function=TIME_SERIES_DAILY\napikey=${ALPHA_KEY}" },
    });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "json" } });
    fireEvent.change(screen.getByLabelText("Body content"), {
      target: { value: '{"symbol": "{{ input }}"}' },
    });
    fireEvent.change(screen.getByLabelText("Response"), { target: { value: "text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "fetch_prices",
      action: "http_request",
      method: "POST",
      url: "https://api.example.test/query",
      headers: { Authorization: "Bearer ${API_TOKEN}", Accept: "application/json" },
      query: { function: "TIME_SERIES_DAILY", apikey: "${ALPHA_KEY}" },
      body: { json: { symbol: "{{ input }}" } },
      response: { mode: "text" },
    });
  });

  it("builds nothing extra when the new fields are left alone", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "fetch_prices",
      action: "http_request",
      method: "GET",
      url: "https://api.example.test/query",
    });
  });

  it("shows an error for a malformed header line and does not submit", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillBasics();
    fireEvent.change(screen.getByLabelText("Headers"), { target: { value: "nonsense" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/line 1/);
  });

  it("shows an error when the json body is not valid JSON", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillBasics();
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "POST" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "json" } });
    fireEvent.change(screen.getByLabelText("Body content"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/JSON/i);
  });

  it("shows the credential error when a header carries a literal secret", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillBasics();
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "Authorization: Bearer literal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/credential/);
  });
});

// Regression (PR #88 Browser E2E): a select's option text must not become part of its label, or
// getByLabel("Name") also matches the Body select ("Form (name=value lines)").
describe("ToolForm -- accessible names (PR #88 regression)", () => {
  afterEach(() => cleanup());

  it("resolves the Name field to exactly one control", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    expect(screen.getAllByLabelText(/name/i)).toHaveLength(1);
  });
});

// KAM-193: a name and URL that cannot work are rejected beside their fields, and an empty field is named.
describe("ToolForm validation (KAM-193)", () => {
  afterEach(() => cleanup());

  const name = () => screen.getByLabelText("Name") as HTMLInputElement;
  const url = () => screen.getByLabelText("URL") as HTMLInputElement;
  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

  it("calls out a name like `my tool!` and a URL like `not a url` as they are typed, and refuses to save them", () => {
    const onSubmit = vi.fn();
    render(<ToolForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(name(), { target: { value: "my tool!" } });
    fireEvent.change(url(), { target: { value: "not a url" } });
    expect(screen.getByTestId("tool-error-name").textContent).toMatch(
      /^Problem: Name can only use letters, digits and underscores/,
    );
    expect(screen.getByTestId("tool-error-url").textContent).toMatch(
      /^Problem: URL must start with http:\/\/ or https:\/\//,
    );
    expect(name().getAttribute("aria-invalid")).toBe("true");
    expect(name().getAttribute("aria-describedby")).toBe(screen.getByTestId("tool-error-name").id);

    save();
    expect(onSubmit).not.toHaveBeenCalled();
    // The messages are beside the fields, and only there: no second list of the same problems.
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    fireEvent.change(name(), { target: { value: "my_tool" } });
    fireEvent.change(url(), { target: { value: "https://api.example.com/{symbol}" } });
    expect(screen.queryByTestId("tool-error-name")).toBeNull();
    expect(screen.queryByTestId("tool-error-url")).toBeNull();
    save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("names each empty field once, beside it, with no schema sentence", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    save();
    expect(screen.getByTestId("tool-error-name").textContent).toBe("Problem: Name is required.");
    expect(screen.getByTestId("tool-error-url").textContent).toBe("Problem: URL is required.");
    expect(document.body.textContent).not.toContain("Too small");
    expect(document.body.textContent).not.toContain("expected string");

    // Typing in a field clears its message.
    fireEvent.change(name(), { target: { value: "x" } });
    expect(screen.queryByTestId("tool-error-name")).toBeNull();
    expect(screen.getByTestId("tool-error-url")).toBeTruthy();
  });

  it("names the empty fields of a Slack connector beside them", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    fireEvent.change(name(), { target: { value: "post" } });
    save();
    expect(screen.getByTestId("tool-error-token").textContent).toBe("Problem: Token is required.");
    expect(screen.getByTestId("tool-error-channel").textContent).toBe(
      "Problem: Channel is required.",
    );
    expect(screen.getByTestId("tool-error-text").textContent).toBe("Problem: Text is required.");
  });

  it("opens the Setup tab on a failed save, so the problem beside its field is seen", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    save();
    expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tool-error-name")).toBeTruthy();
  });

  it("lists a problem that has no field of its own in the error box, and no field summary beside it", () => {
    render(<ToolForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(name(), { target: { value: "ok_name" } });
    fireEvent.change(url(), { target: { value: "https://api.example.test/q" } });
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "Authorization: Bearer literal" },
    });
    save();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toMatch(/credential/);
  });

  it("does not hold an existing tool's name against it when editing", () => {
    render(
      <ToolForm
        initial={{
          name: "legacy tool",
          action: "http_request",
          method: "GET",
          url: "https://x.test/",
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("tool-error-name")).toBeNull();
  });
});
