import { fireEvent, screen } from "@testing-library/react";

// KAM-214: Add Tool, Add Workflow Step and Edit Steps live in the run bar's menu now.
const LABELS: Record<string, string> = {
  "Add Tool": "Add tool",
  "Add Workflow Step": "Add step",
  "Edit Steps": "Edit steps",
};

export function chooseFromMenu(name: keyof typeof LABELS | string): void {
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: LABELS[name] ?? name }));
}
