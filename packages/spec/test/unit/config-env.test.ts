import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";

// KAN-1844: a component tool's config may read ${ENV}, but not a variable named like a secret.

const spec = (config: string) => `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: db
      action: component
      use: kampong/supabase@0.1.0
      op: select
      config:
${config}
  workflow:
    - step: s
      action: go
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("config values that read the environment", () => {
  it("are accepted", () => {
    expect(messages(spec('        project: "${SUPABASE_PROJECT}"'))).toEqual([]);
  });

  it("are refused when the variable looks like a secret, pointing at auth slots", () => {
    const errors = messages(spec('        project: "${SUPABASE_SERVICE_KEY}"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/config\.project reads SUPABASE_SERVICE_KEY.*auth slot/);
  });
});
