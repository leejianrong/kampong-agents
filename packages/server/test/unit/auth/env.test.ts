import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getAuthBaseUrl,
  getAuthSecret,
  getByokRootKey,
  getGithubOAuthConfig,
  getPreviewNotice,
  getIngressLimits,
  getRunLimits,
  getTrustProxy,
  getPublicBaseUrl,
} from "../../../src/auth/env.js";

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

describe("getByokRootKey", () => {
  it("throws a clear, actionable error when BYOK_ROOT_KEY is unset", () => {
    expect(() => getByokRootKey({})).toThrow(/BYOK_ROOT_KEY is not set/);
  });

  it("returns a 32-byte Buffer for a valid base64 256-bit key", () => {
    const encoded = randomBytes(32).toString("base64");
    const key = getByokRootKey({ BYOK_ROOT_KEY: encoded });
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("base64")).toBe(encoded);
  });

  it("rejects a key that decodes to the wrong number of bytes", () => {
    expect(() => getByokRootKey({ BYOK_ROOT_KEY: randomBytes(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
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

describe("getPublicBaseUrl (KAM-321)", () => {
  it("is undefined when unset or blank", () => {
    expect(getPublicBaseUrl({})).toBeUndefined();
    expect(getPublicBaseUrl({ PUBLIC_BASE_URL: "  " })).toBeUndefined();
  });

  it("returns the origin and drops a trailing slash", () => {
    expect(getPublicBaseUrl({ PUBLIC_BASE_URL: "https://kampong.abangai.dev/" })).toBe(
      "https://kampong.abangai.dev",
    );
    expect(getPublicBaseUrl({ PUBLIC_BASE_URL: "http://localhost:8080" })).toBe(
      "http://localhost:8080",
    );
  });

  it("refuses a value that is not a plain http(s) origin", () => {
    expect(() => getPublicBaseUrl({ PUBLIC_BASE_URL: "kampong.abangai.dev" })).toThrow(/valid URL/);
    expect(() => getPublicBaseUrl({ PUBLIC_BASE_URL: "ftp://kampong.abangai.dev" })).toThrow(
      /http:\/\/ or https:\/\//,
    );
    expect(() => getPublicBaseUrl({ PUBLIC_BASE_URL: "https://kampong.abangai.dev/app" })).toThrow(
      /no path/,
    );
  });
});

describe("getPreviewNotice (KAM-320)", () => {
  it("is undefined when unset or blank, trimmed when set", () => {
    expect(getPreviewNotice({})).toBeUndefined();
    expect(getPreviewNotice({ PREVIEW_NOTICE: "  " })).toBeUndefined();
    expect(getPreviewNotice({ PREVIEW_NOTICE: " Preview, no SLA " })).toBe("Preview, no SLA");
  });
  it("refuses a notice that is too long to be a banner", () => {
    expect(() => getPreviewNotice({ PREVIEW_NOTICE: "x".repeat(301) })).toThrow(/300/);
  });
});

describe("getIngressLimits (KAM-322)", () => {
  it("leaves out anything unset so the defaults apply", () => {
    expect(getIngressLimits({})).toEqual({});
  });
  it("reads each limit", () => {
    expect(
      getIngressLimits({
        INGRESS_DEPLOYMENT_PER_MINUTE: "30",
        INGRESS_IP_PER_MINUTE: "100",
        INGRESS_MAX_BODY_BYTES: "65536",
      }),
    ).toEqual({ deploymentPerMinute: 30, ipPerMinute: 100, maxBodyBytes: 65536 });
  });
  it("refuses a value that is not a whole number of at least 1", () => {
    expect(() => getIngressLimits({ INGRESS_IP_PER_MINUTE: "0" })).toThrow(/INGRESS_IP_PER_MINUTE/);
    expect(() => getIngressLimits({ INGRESS_MAX_BODY_BYTES: "lots" })).toThrow(
      /INGRESS_MAX_BODY_BYTES/,
    );
  });
});

describe("getTrustProxy (KAM-322)", () => {
  it("is on only for the exact value true", () => {
    expect(getTrustProxy({})).toBe(false);
    expect(getTrustProxy({ TRUST_PROXY: "1" })).toBe(false);
    expect(getTrustProxy({ TRUST_PROXY: "true" })).toBe(true);
  });
});

describe("getRunLimits (KAM-323)", () => {
  it("leaves out anything unset so the defaults apply", () => {
    expect(getRunLimits({})).toEqual({});
  });
  it("reads each limit, with minutes turned into milliseconds, and 0 means off", () => {
    expect(
      getRunLimits({ RUN_MAX_CONCURRENT: "3", RUN_MAX_PER_MONTH: "0", RUN_MAX_MINUTES: "20" }),
    ).toEqual({ maxConcurrent: 3, maxPerMonth: 0, maxRuntimeMs: 1_200_000 });
  });
  it("refuses a value that is not a whole number of at least 0", () => {
    expect(() => getRunLimits({ RUN_MAX_CONCURRENT: "-1" })).toThrow(/RUN_MAX_CONCURRENT/);
    expect(() => getRunLimits({ RUN_MAX_MINUTES: "soon" })).toThrow(/RUN_MAX_MINUTES/);
  });
});
