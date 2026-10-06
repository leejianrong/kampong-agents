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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Save Tool" }));

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
