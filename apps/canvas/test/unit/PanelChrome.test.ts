import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// KAM-178: a panel draws neither its own footer nor its own error box; both come from Panel.tsx so every panel
// looks and behaves alike. These class names are what a hand-rolled footer or error box used.
const PANELS = [
  "ToolForm",
  "ComponentToolForm",
  "WorkflowStepForm",
  "GuardrailsForm",
  "VarsPanel",
  "TriggerPanel",
  "StepsPanel",
  "SecretsPanel",
  "DoctorPanel",
  "RunPanel",
  "ImportPanel",
];
const OWN_CHROME = [
  "md3-form-actions",
  "md3-trust__actions",
  "md3-error-list",
  "md3-banner--error",
];

describe("panel chrome", () => {
  for (const name of PANELS) {
    it(`${name} uses the shared footer and error box`, () => {
      const source = readFileSync(join(__dirname, "../../src", `${name}.tsx`), "utf8");
      for (const cls of OWN_CHROME) expect(source, `${name} renders ${cls}`).not.toContain(cls);
    });
  }
});
