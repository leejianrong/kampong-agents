import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseComponentManifest, type AgentSpec } from "@kampong/spec";
import {
  buildDockerfile,
  buildEntryPointSource,
  buildServerEntryPointSource,
  collectRequiredEnvVars,
  exportProject,
  ExportMissingComponentsError,
  requiredComponentRefs,
  type ExportComponent,
} from "../../src/index.js";

// KAN-1886: an export carries the component interpreter and the components its spec uses, so
// `action: component` tools and the desugared Slack and Gmail tools run in the exported project.

const BASE = {
  id: "agent",
  name: "Agent",
  role: "R",
  goal: "G",
  workflow: [{ step: "go", type: "tool", tool: "t" }],
};

function specWith(tools: unknown[]): AgentSpec {
  return { version: "1.0", agent: { ...BASE, tools } } as unknown as AgentSpec;
}

const COMPONENT_TOOL = {
  name: "t",
  action: "component",
  use: "acme/tickets@1.0.0",
  op: "get",
  with: { id: "1" },
};
const SLACK_TOOL = {
  name: "s",
  action: "slack_post_message",
  token: "${MY_SLACK}",
  channel: "#c",
  text: "x",
};
const GMAIL_TOOL = {
  name: "g",
  action: "gmail_send",
  token: "${MY_GMAIL}",
  to: "a@b.c",
  subject: "s",
  body: "b",
};

const TICKETS = `kind: module
id: acme/tickets
version: 1.0.0
entry: ./index.mjs
permissions: { egress: [tickets.example.test] }
auth:
  slots:
    token: { env: TICKETS_TOKEN, hosts: [tickets.example.test] }
ops:
  get:
    effect: read
    input: { type: object, properties: { id: { type: string } } }
`;

function ticketsComponent(overrides: Partial<ExportComponent> = {}): ExportComponent {
  const manifest = parseComponentManifest(TICKETS).manifest!;
  return {
    manifest,
    digest: `sha256:${"a".repeat(64)}`,
    files: {
      "component.yaml": Buffer.from(TICKETS),
      "index.mjs": Buffer.from("export async function invoke() { return { ok: true }; }\n"),
    },
    ...overrides,
  };
}

describe("requiredComponentRefs", () => {
  it("lists component tools and the first-party components the legacy kinds desugar to, once each, sorted", () => {
    expect(
      requiredComponentRefs(
        specWith([COMPONENT_TOOL, SLACK_TOOL, GMAIL_TOOL, { ...SLACK_TOOL, name: "s2" }]),
      ),
    ).toEqual(["acme/tickets@1.0.0", "kampong/gmail@1.0.0", "kampong/slack@1.0.0"]);
  });

  it("is empty for a spec that uses neither", () => {
    expect(
      requiredComponentRefs(
        specWith([{ name: "t", action: "http_request", method: "GET", url: "https://x.test" }]),
      ),
    ).toEqual([]);
    expect(requiredComponentRefs({ version: "1.0", agent: BASE } as unknown as AgentSpec)).toEqual(
      [],
    );
  });
});

describe("exportProject with components", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-export-components-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const out = () => join(dir, "out");

  it("refuses, naming what is missing, and writes nothing", () => {
    expect(() => exportProject(specWith([COMPONENT_TOOL, SLACK_TOOL]), out())).toThrow(
      ExportMissingComponentsError,
    );
    expect(() => exportProject(specWith([COMPONENT_TOOL, SLACK_TOOL]), out())).toThrow(
      /acme\/tickets@1\.0\.0.*kampong\/slack@1\.0\.0/s,
    );
    expect(existsSync(out())).toBe(false);
  });

  it("copies each component's files byte for byte under components/<id>/<version>/", () => {
    exportProject(specWith([COMPONENT_TOOL]), out(), { components: [ticketsComponent()] });
    const base = join(out(), "components", "acme", "tickets", "1.0.0");
    expect(readFileSync(join(base, "component.yaml"), "utf8")).toBe(TICKETS);
    expect(readFileSync(join(base, "index.mjs"), "utf8")).toContain("invoke");
  });

  it("bakes the manifests and digests into src/components.generated.ts and wires it into both entry points", () => {
    exportProject(specWith([COMPONENT_TOOL]), out(), { components: [ticketsComponent()] });
    const generated = readFileSync(join(out(), "src", "components.generated.ts"), "utf8");
    expect(generated).toContain("acme/tickets");
    expect(generated).toContain(`sha256:${"a".repeat(64)}`);
    expect(generated).toContain("StaticComponentRegistry");
    expect(generated).toContain("InProcessModuleRunner");
    for (const file of ["index.ts", "server.ts"]) {
      const source = readFileSync(join(out(), "src", file), "utf8");
      expect(source).toContain("components.generated.js");
      expect(source).toMatch(/components/);
    }
    expect(existsSync(join(out(), "src", "runtime", "component.ts"))).toBe(true);
    expect(existsSync(join(out(), "src", "runtime", "component-core.ts"))).toBe(true);
  });

  it("lists the components and their digests in the README", () => {
    exportProject(specWith([COMPONENT_TOOL]), out(), { components: [ticketsComponent()] });
    const readme = readFileSync(join(out(), "README.md"), "utf8");
    expect(readme).toContain("## Components");
    expect(readme).toContain(`acme/tickets@1.0.0`);
    expect(readme).toContain(`sha256:${"a".repeat(64)}`);
  });

  it("ships only the components the spec uses", () => {
    const extra: ExportComponent = {
      ...ticketsComponent(),
      manifest: { ...ticketsComponent().manifest, id: "acme/unused" },
    };
    exportProject(specWith([COMPONENT_TOOL]), out(), {
      components: [ticketsComponent(), extra],
    });
    expect(existsSync(join(out(), "components", "acme", "unused"))).toBe(false);
    expect(readFileSync(join(out(), "src", "components.generated.ts"), "utf8")).not.toContain(
      "acme/unused",
    );
  });

  it("copies the components folder into the Docker image only when there is one", () => {
    expect(buildDockerfile({ components: true })).toContain("COPY components ./components");
    expect(buildDockerfile()).not.toContain("components");
    expect(buildDockerfile({ components: false })).not.toContain("COPY components");
  });

  it("leaves an export that uses no component byte-identical to before: no generated module, no wiring", () => {
    const spec = specWith([
      { name: "t", action: "http_request", method: "GET", url: "https://x.test" },
    ]);
    exportProject(spec, out());
    expect(existsSync(join(out(), "src", "components.generated.ts"))).toBe(false);
    expect(existsSync(join(out(), "components"))).toBe(false);
    expect(readFileSync(join(out(), "src", "index.ts"), "utf8")).toBe(buildEntryPointSource(spec));
    expect(readFileSync(join(out(), "src", "server.ts"), "utf8")).toBe(
      buildServerEntryPointSource(spec),
    );
  });

  it.each([
    "../escape.txt",
    "a/../../escape.txt",
    "/abs/escape.txt",
    "..\\escape.txt",
    "C:\\escape.txt",
    "C:escape.txt",
    "",
  ])("refuses a component file path that could leave the component directory: %j", (path) => {
    const component = ticketsComponent({
      files: { "component.yaml": Buffer.from(TICKETS), [path]: Buffer.from("x") },
    });
    expect(() =>
      exportProject(specWith([COMPONENT_TOOL]), out(), { components: [component] }),
    ).toThrow(/unsafe|path/i);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
  });

  it("refuses a manifest whose id or version could escape the components folder", () => {
    // A spec that skipped validation can name anything; the manifest must still be a valid id and version.
    const hostile = ticketsComponent({
      manifest: { ...ticketsComponent().manifest, version: "../../x" } as never,
    });
    const spec = specWith([{ ...COMPONENT_TOOL, use: "acme/tickets@../../x" }]);
    expect(() => exportProject(spec, out(), { components: [hostile] })).toThrow(/not a valid id/);
    expect(existsSync(join(dir, "x"))).toBe(false);
  });
});

describe("required env vars for components", () => {
  it("lists a used component's default secret variable unless the tool remaps it", () => {
    const spec = specWith([COMPONENT_TOOL]);
    expect(collectRequiredEnvVars(spec, [ticketsComponent()])).toContain("TICKETS_TOKEN");
    const remapped = specWith([{ ...COMPONENT_TOOL, secrets: { token: "${OTHER}" } }]);
    const vars = collectRequiredEnvVars(remapped, [ticketsComponent()]);
    expect(vars).toContain("OTHER");
    expect(vars).not.toContain("TICKETS_TOKEN");
  });

  it("does not list a component's variable when no tool uses it", () => {
    expect(collectRequiredEnvVars(specWith([]), [ticketsComponent()])).not.toContain(
      "TICKETS_TOKEN",
    );
  });
});
