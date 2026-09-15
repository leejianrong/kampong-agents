import { describe, expect, it } from "vitest";
import { getAuthBaseUrl, getAuthSecret, getGithubOAuthConfig } from "../../../src/auth/env.js";

// KAN-1226 (ADR-0015): mirrors test/unit/db/client.test.ts's own coverage of
// getDatabaseUrl -- these are the equivalent read-env-or-(throw|omit) helpers
// for Better Auth's own required/optional config, meaningfully testable
// without a live DB or a real GitHub OAuth app.

describe("getAuthSecret", () => {
  it("throws a clear, actionable error when BETTER_AUTH_SECRET is unset", () => {
    expect(() => getAuthSecret({})).toThrow(/BETTER_AUTH_SECRET is not set/);
  });

  it("returns the value from the given env", () => {
    expect(getAuthSecret({ BETTER_AUTH_SECRET: "a-real-secret" })).toBe("a-real-secret");
  });

  it("defaults to process.env when no env is given", () => {
    const previous = process.env["BETTER_AUTH_SECRET"];
    process.env["BETTER_AUTH_SECRET"] = "process-env-secret";
    try {
      expect(getAuthSecret()).toBe("process-env-secret");
    } finally {
      if (previous === undefined) delete process.env["BETTER_AUTH_SECRET"];
      else process.env["BETTER_AUTH_SECRET"] = previous;
    }
  });
});

describe("getGithubOAuthConfig", () => {
  it("returns undefined (not a throw) when both env vars are unset", () => {
    expect(getGithubOAuthConfig({})).toBeUndefined();
  });

  it("returns undefined when only GITHUB_CLIENT_ID is set", () => {
    expect(getGithubOAuthConfig({ GITHUB_CLIENT_ID: "id-only" })).toBeUndefined();
  });

  it("returns undefined when only GITHUB_CLIENT_SECRET is set", () => {
    expect(getGithubOAuthConfig({ GITHUB_CLIENT_SECRET: "secret-only" })).toBeUndefined();
  });

  it("returns { clientId, clientSecret } when both are set", () => {
    expect(
      getGithubOAuthConfig({
        GITHUB_CLIENT_ID: "some-client-id",
        GITHUB_CLIENT_SECRET: "some-client-secret",
      }),
    ).toEqual({ clientId: "some-client-id", clientSecret: "some-client-secret" });
  });
});

describe("getAuthBaseUrl", () => {
  it("returns undefined when BETTER_AUTH_URL is unset", () => {
    expect(getAuthBaseUrl({})).toBeUndefined();
  });

  it("returns the value from the given env", () => {
    expect(getAuthBaseUrl({ BETTER_AUTH_URL: "https://kampong.example.com" })).toBe(
      "https://kampong.example.com",
    );
  });
});
