import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecStore } from "../../src/spec-store.js";

const VALID_SOURCE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

describe("SpecStore", () => {
  let dir: string;
  let specPath: string;
  let layoutPath: string;
  let store: SpecStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-spec-store-"));
    specPath = join(dir, "agent.yaml");
    layoutPath = join(dir, "layout.json");
    writeFileSync(specPath, VALID_SOURCE);
    store = new SpecStore(specPath, layoutPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a spec and auto-assigns + persists layout for nodes with no stored position", async () => {
    const result = await store.loadWithLayout();

    expect(result.success).toBe(true);
    expect(result.layout["agent:greeter"]).toBeDefined();
    expect(result.layout["workflow:greet"]).toBeDefined();

    const onDisk = JSON.parse(readFileSync(layoutPath, "utf8"));
    expect(onDisk).toEqual(result.layout);
  });

  it("applies a valid patch and writes it to disk", async () => {
    const result = await store.applyPatchAndSave([
      { op: "set", path: ["agent", "goal"], value: "Updated goal" },
    ]);

    expect(result.success).toBe(true);
    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("Updated goal");
  });

  it("never writes an invalid mutation to disk", async () => {
    const before = readFileSync(specPath, "utf8");
    const result = await store.applyPatchAndSave([
      { op: "set", path: ["agent", "workflow", 0, "step"], value: "" }, // violates min(1)
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });

  // KAN-1224: `list()` is a new, best-effort discovery capability the
  // `SpecRepository` interface adds -- it does NOT make `kampong dev`
  // multi-spec-aware (ADR-0011 is unchanged), it just enumerates whatever
  // *.yaml/*.yml files happen to sit next to the spec this store is scoped
  // to.
  it("list() enumerates yaml files in the spec's directory", async () => {
    writeFileSync(join(dir, "other.yaml"), VALID_SOURCE);
    writeFileSync(join(dir, "notes.txt"), "not a spec");

    const specs = await store.list();

    expect(specs.map((s) => s.id).sort()).toEqual(["agent.yaml", "other.yaml"]);
    expect(specs.find((s) => s.id === "agent.yaml")?.name).toBe("agent");
  });
});
