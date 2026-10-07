import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseComponentManifest, parseLockfile, type AgentSpec } from "@kampong/spec";
import { digestOfFiles, exportProject, type ExportComponent } from "../../src/index.js";
import {
  ComponentVerificationError,
  hashComponentDirectory,
  verifyComponents,
} from "../../templates/runtime/component-verify.js";

// KAN-1837: an export leaves a lockfile and an SBOM, and re-checks components/ against the digests it
// recorded, so a tampered component fails verification.

const SPEC = {
  version: "1.0",
  agent: {
    id: "agent",
    name: "Agent",
    role: "R",
    goal: "G",
    tools: [{ name: "t", action: "component", use: "acme/tickets@1.0.0", op: "get", with: {} }],
    workflow: [{ step: "go", type: "tool", tool: "t" }],
  },
} as unknown as AgentSpec;

const YAML = `kind: module
id: acme/tickets
version: 1.0.0
entry: ./index.mjs
deps: { "@acme/sdk": 2.1.0, left-pad: 1.3.0 }
permissions: { egress: [tickets.example.test] }
ops:
  get:
    effect: read
    input: { type: object }
`;
const FILES = {
  "component.yaml": Buffer.from(YAML),
  "index.mjs": Buffer.from("export async function invoke() { return 1; }\n"),
  "lib/helper.mjs": Buffer.from("export const x = 1;\n"),
};
const COMPONENT: ExportComponent = {
  manifest: parseComponentManifest(YAML).manifest!,
  digest: digestOfFiles(FILES),
  files: FILES,
};

describe("export records and startup verification", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-export-verify-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

  it("writes a kampong.lock the CLI can read, carrying the digest and the permissions", () => {
    exportProject(SPEC, dir, { components: [COMPONENT] });
    const lock = parseLockfile(read("kampong.lock")).lockfile!;
    expect(lock.components["acme/tickets@1.0.0"]!.digest).toBe(COMPONENT.digest);
    expect(lock.components["acme/tickets@1.0.0"]!.permissions?.egress).toEqual([
      "tickets.example.test",
    ]);
  });

  it("writes a CycloneDX SBOM with each component's digest, each file's hash, and its pinned dependencies", () => {
    exportProject(SPEC, dir, { components: [COMPONENT] });
    const sbom = JSON.parse(read("sbom.json"));
    expect(sbom.bomFormat).toBe("CycloneDX");
    const [component, ...deps] = sbom.components;
    expect(component.name).toBe("acme/tickets");
    expect(component.properties).toContainEqual({
      name: "kampong:digest",
      value: COMPONENT.digest,
    });
    expect(component.components.map((f: { name: string }) => f.name)).toEqual([
      "component.yaml",
      "index.mjs",
      "lib/helper.mjs",
    ]);
    expect(component.components[0].hashes[0].alg).toBe("SHA-256");
    expect(deps.map((d: { purl: string }) => d.purl)).toEqual([
      "pkg:npm/%40acme/sdk@2.1.0",
      "pkg:npm/left-pad@1.3.0",
    ]);
  });

  it("is reproducible: exporting twice writes the same SBOM and lockfile", () => {
    const other = mkdtempSync(join(tmpdir(), "kampong-export-verify-"));
    try {
      exportProject(SPEC, dir, { components: [COMPONENT] });
      exportProject(SPEC, other, { components: [COMPONENT] });
      for (const file of ["sbom.json", "kampong.lock"]) {
        expect(readFileSync(join(other, file), "utf8")).toBe(read(file));
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("adds `npm run verify` and the verifying startup only when components are exported", () => {
    exportProject(SPEC, dir, { components: [COMPONENT] });
    expect(JSON.parse(read("package.json")).scripts.verify).toBe("tsx src/verify.ts");
    expect(read("src/components.generated.ts")).toContain("await verifyComponents(");
    expect(read("src/verify.ts")).toContain("sbom.json");

    const plain = mkdtempSync(join(tmpdir(), "kampong-export-verify-"));
    try {
      exportProject(
        { version: "1.0", agent: { ...SPEC.agent, tools: [] } } as unknown as AgentSpec,
        plain,
      );
      expect(
        JSON.parse(readFileSync(join(plain, "package.json"), "utf8")).scripts.verify,
      ).toBeUndefined();
      expect(() => readFileSync(join(plain, "sbom.json"))).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  describe("verifyComponents against an exported project", () => {
    const expectedFor = () => ({
      ref: "acme/tickets@1.0.0",
      digest: COMPONENT.digest,
      path: "acme/tickets/1.0.0",
      files: JSON.parse(read("sbom.json")).components[0].components.reduce(
        (acc: Record<string, string>, f: { name: string; hashes: { content: string }[] }) => ({
          ...acc,
          [f.name]: f.hashes[0]!.content,
        }),
        {},
      ),
    });
    const componentDir = () => join(dir, "components", "acme", "tickets", "1.0.0");

    beforeEach(() => exportProject(SPEC, dir, { components: [COMPONENT] }));

    it("computes the same digest the registry recorded", async () => {
      expect((await hashComponentDirectory(componentDir())).digest).toBe(COMPONENT.digest);
    });

    it("passes on the files that were exported", async () => {
      await expect(
        verifyComponents([expectedFor()], join(dir, "components")),
      ).resolves.toBeUndefined();
    });

    it("fails on a changed file and says which", async () => {
      appendFileSync(join(componentDir(), "index.mjs"), "// injected\n");
      const err = await verifyComponents([expectedFor()], join(dir, "components")).catch((e) => e);
      expect(err).toBeInstanceOf(ComponentVerificationError);
      expect(err.message).toContain("acme/tickets@1.0.0");
      expect(err.message).toContain("index.mjs was changed");
    });

    it("fails on an added file, a removed file and a missing component", async () => {
      writeFileSync(join(componentDir(), "extra.mjs"), "x");
      rmSync(join(componentDir(), "lib", "helper.mjs"));
      let err = await verifyComponents([expectedFor()], join(dir, "components")).catch((e) => e);
      expect(err.message).toContain("extra.mjs was added");
      expect(err.message).toContain("lib/helper.mjs is missing");

      rmSync(componentDir(), { recursive: true });
      err = await verifyComponents([expectedFor()], join(dir, "components")).catch((e) => e);
      expect(err.message).toContain("cannot be read");
    });

    it("fails on a symlink, which could point outside the component", async () => {
      symlinkSync("/etc/hostname", join(componentDir(), "link.mjs"));
      const err = await verifyComponents([expectedFor()], join(dir, "components")).catch((e) => e);
      expect(err.message).toContain("link.mjs is a symlink");
    });

    it("ignores node_modules, as the registry does", async () => {
      mkdirSync(join(componentDir(), "node_modules", "x"), { recursive: true });
      writeFileSync(join(componentDir(), "node_modules", "x", "i.js"), "x");
      await expect(
        verifyComponents([expectedFor()], join(dir, "components")),
      ).resolves.toBeUndefined();
    });

    it("reports every component that differs, not only the first", async () => {
      const other = { ...expectedFor(), ref: "acme/other@1.0.0", path: "acme/other/1.0.0" };
      const err = await verifyComponents([expectedFor(), other], join(dir, "components")).catch(
        (e) => e,
      );
      expect(err.problems).toHaveLength(1);
      expect(err.message).toContain("acme/other@1.0.0");
    });
  });
});
