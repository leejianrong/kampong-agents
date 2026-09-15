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
