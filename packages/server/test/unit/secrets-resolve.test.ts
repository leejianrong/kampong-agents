import { describe, expect, it } from "vitest";
import {
  envNamesIn,
  resolveWorkspaceSecrets,
  SECRET_NAME_RE,
  secretNamesFor,
} from "../../src/secrets/resolve.js";
import type { DbClient } from "../../src/db/client.js";

// KAM-81: which `${NAME}`s a spec reads, and that looking up none touches neither the database nor the root key.

describe("envNamesIn", () => {
  it("finds every placeholder in nested values and skips escapes", () => {
    const spec = {
      tools: [
        { headers: { Authorization: "Bearer ${SLACK_BOT_TOKEN}" }, url: "${SUPABASE_URL}/rest" },
      ],
      vars: { n: "$${NOT_A_REF}", tickers: ["a", "${EXTRA_1}"] },
      count: 3,
    };
    expect([...envNamesIn(spec)].sort()).toEqual(["EXTRA_1", "SLACK_BOT_TOKEN", "SUPABASE_URL"]);
  });

  it("ignores lower-case and malformed references (those are expressions, not env names)", () => {
    expect([...envNamesIn("${step.field} ${lower} ${}")]).toEqual([]);
  });
});

describe("SECRET_NAME_RE", () => {
  it("accepts environment-variable names only", () => {
    expect(SECRET_NAME_RE.test("SLACK_BOT_TOKEN")).toBe(true);
    expect(SECRET_NAME_RE.test("slack")).toBe(false);
    expect(SECRET_NAME_RE.test("1A")).toBe(false);
    expect(SECRET_NAME_RE.test("A".repeat(65))).toBe(false);
  });
});

describe("resolveWorkspaceSecrets", () => {
  it("returns nothing, without a database or a root key, when there are no names to look up", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("must not touch the database");
        },
      },
    ) as unknown as DbClient;
    expect(await resolveWorkspaceSecrets({ db, workspaceId: "w", names: [], env: {} })).toEqual({});
    expect(
      await resolveWorkspaceSecrets({ db, workspaceId: "w", names: ["not valid"], env: {} }),
    ).toEqual({});
  });
});

describe("secretNamesFor", () => {
  const spec = (secrets?: Record<string, string>) => ({
    agent: {
      tools: [
        {
          action: "component",
          use: "kampong/slack@1.0.0",
          ...(secrets ? { secrets } : {}),
        },
        { action: "http_request", headers: { "X-Key": "${PLAIN_KEY}" } },
      ],
    },
  });

  it("adds a first-party component's credential slots to the placeholders in the spec", async () => {
    const names = await secretNamesFor(spec());
    expect(names.has("PLAIN_KEY")).toBe(true);
    expect(names.has("SLACK_BOT_TOKEN")).toBe(true);
  });

  it("follows the tool's own remap of a slot", async () => {
    const slot = [...(await secretNamesFor(spec()))].find((n) => n === "SLACK_BOT_TOKEN");
    expect(slot).toBeDefined();
    const names = await secretNamesFor(spec({ token: "${TEAM_SLACK_TOKEN}" }));
    expect(names.has("TEAM_SLACK_TOKEN")).toBe(true);
  });

  it("ignores a component it cannot resolve instead of failing", async () => {
    const names = await secretNamesFor({
      agent: {
        tools: [
          { action: "component", use: "acme/nope@9.9.9" },
          { action: "component", use: "bad" },
        ],
      },
    });
    expect([...names]).toEqual([]);
  });
});
