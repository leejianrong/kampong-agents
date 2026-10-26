import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import { runDoctor, type DoctorOptions } from "../../src/doctor.js";

// KAM-249: doctor says nothing about the assistant when it is not set up, names where prompts would go when it is,
// and only with --probe sends the key to ask for the model list.

const SOURCE = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: s
      action: x
`;

describe("doctor: the assistant", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-doctor-assistant-"));
    writeFileSync(join(dir, "agent.yaml"), SOURCE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: NodeJS.ProcessEnv, extra: Partial<DoctorOptions> = {}) =>
    runDoctor(parseSpec(SOURCE).spec!, join(dir, "agent.yaml"), { env, ...extra }).then((checks) =>
      checks.filter((c) => c.area === "assistant"),
    );
  const KEY = "sk-doctor-key";
  const env = { OPENROUTER_API_KEY: KEY, KAMPONG_ASSISTANT_MODEL: "vendor/model" };

  it("says nothing when it is not set up", async () => {
    expect(await run({})).toEqual([]);
  });

  it("warns when it is half set up", async () => {
    const checks = await run({ OPENROUTER_API_KEY: KEY });
    expect(checks).toEqual([
      {
        status: "warn",
        area: "assistant",
        message: expect.stringContaining("KAMPONG_ASSISTANT_MODEL"),
      },
    ]);
  });

  it("names where prompts would go without contacting it or printing the key", async () => {
    let called = 0;
    const checks = await run(env, {
      assistantFetch: async () => {
        called++;
        return new Response("{}");
      },
    });
    expect(called).toBe(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.message).toContain("openrouter.ai (model vendor/model)");
    expect(JSON.stringify(checks)).not.toContain(KEY);
  });

  it("with probe asks for the model list with the key, and reports a refusal", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const ok = await run(env, {
      probe: true,
      assistantFetch: async (url, init) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return Response.json({ data: [] });
      },
    });
    expect(seen).toEqual([{ url: "https://openrouter.ai/api/v1/models", auth: `Bearer ${KEY}` }]);
    expect(ok.map((c) => c.status)).toEqual(["pass", "pass"]);

    const refused = await run(env, {
      probe: true,
      assistantFetch: async () => new Response("", { status: 401 }),
    });
    expect(refused[1]).toMatchObject({ status: "fail" });
    expect(refused[1]!.message).toContain("refused");
    expect(JSON.stringify(refused)).not.toContain(KEY);

    const down = await run(env, {
      probe: true,
      assistantFetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(down[1]).toMatchObject({ status: "fail" });
  });
});
