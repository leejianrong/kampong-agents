import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { buildSecurityTxt, getSecurityTxtConfig } from "../../src/security-txt.js";

// KAM-331: /.well-known/security.txt (RFC 9116).

describe("getSecurityTxtConfig", () => {
  it("is undefined when no contact is set, so nothing is served", () => {
    expect(getSecurityTxtConfig({})).toBeUndefined();
    expect(getSecurityTxtConfig({ SECURITY_CONTACT: "  " })).toBeUndefined();
  });
  it("accepts a mailto: or https contact and an https policy", () => {
    expect(
      getSecurityTxtConfig({
        SECURITY_CONTACT: "mailto:security@example.com",
        SECURITY_POLICY_URL: "https://example.com/security",
      }),
    ).toEqual({ contact: "mailto:security@example.com", policy: "https://example.com/security" });
    expect(getSecurityTxtConfig({ SECURITY_CONTACT: "https://example.com/report" })).toEqual({
      contact: "https://example.com/report",
    });
  });
  it("refuses a contact that is not a mailto: or https URI, and a non-https policy", () => {
    expect(() => getSecurityTxtConfig({ SECURITY_CONTACT: "security@example.com" })).toThrow(
      /mailto:/,
    );
    expect(() => getSecurityTxtConfig({ SECURITY_CONTACT: "http://example.com" })).toThrow();
    expect(() =>
      getSecurityTxtConfig({
        SECURITY_CONTACT: "mailto:a@b.co",
        SECURITY_POLICY_URL: "http://example.com",
      }),
    ).toThrow(/SECURITY_POLICY_URL/);
  });
});

describe("buildSecurityTxt", () => {
  it("has a Contact and an Expires about 180 days ahead, and a Policy when given", () => {
    const text = buildSecurityTxt(
      { contact: "mailto:security@example.com", policy: "https://example.com/security" },
      new Date("2026-11-28T00:00:00.000Z"),
    );
    expect(text).toContain("Contact: mailto:security@example.com\n");
    expect(text).toContain("Expires: 2027-05-27T00:00:00.000Z\n");
    expect(text).toContain("Policy: https://example.com/security\n");
  });
});

describe("GET /.well-known/security.txt", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("is 404 when no contact is configured", async () => {
    app = createServer();
    expect((await app.inject({ method: "GET", url: "/.well-known/security.txt" })).statusCode).toBe(
      404,
    );
  });

  it("serves plain text with the contact when one is configured", async () => {
    app = createServer({ securityTxt: { contact: "mailto:security@example.com" } });
    const res = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toMatch(/^Contact: mailto:security@example\.com$/m);
    expect(res.body).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T/m);
  });
});
