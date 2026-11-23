import { describe, expect, it } from "vitest";
import { envNamesIn, resolveWorkspaceSecrets, SECRET_NAME_RE } from "../../src/secrets/resolve.js";
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
