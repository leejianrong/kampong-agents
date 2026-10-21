import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTemplates } from "../../src/templates.js";

// KAM-216: the gallery picks up any folder with an agent.yaml, so a new template needs no code change.

const SPEC = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: ask
      action: say
    - step: send
      type: tool
      tool: post
`;

describe("listTemplates", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-templates-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("picks up a new folder with its title, description, step kinds and offline flag", () => {
    const folder = join(dir, "new-one");
    mkdirSync(join(folder, "fixtures"), { recursive: true });
    writeFileSync(join(folder, "agent.yaml"), SPEC);
    writeFileSync(
      join(folder, "template.json"),
      JSON.stringify({ title: "A new job", description: "Does a job." }),
    );
    const [t] = listTemplates(dir);
    expect(t).toMatchObject({
      name: "new-one",
      title: "A new job",
      description: "Does a job.",
      stepKinds: ["action", "tool"],
      runsOffline: true,
    });
  });

  it("falls back to the folder name and no offline badge without metadata or fixtures", () => {
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "plain", "agent.yaml"), SPEC);
    mkdirSync(join(dir, "not-a-template"));
    const list = listTemplates(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "plain", description: "", runsOffline: false });
  });
});
