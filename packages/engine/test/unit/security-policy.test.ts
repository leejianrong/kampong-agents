import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KAN-1838: a disclosure path exists and security.txt (RFC 9116) is well formed and not expired.

const root = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

describe("security policy", () => {
  const txt = readFileSync(root(".well-known/security.txt"), "utf8");
  const field = (name: string) => txt.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];

  it("names a contact that is a private reporting channel", () => {
    expect(field("Contact")).toMatch(/^https:\/\/github\.com\/.+\/security\/advisories\/new$/);
  });

  it("has an Expires that is in the future and no more than a year ahead (RFC 9116 asks for under a year)", () => {
    const expires = new Date(field("Expires")!);
    expect(Number.isNaN(expires.getTime())).toBe(false);
    // When this fails, renew the date in .well-known/security.txt after checking the contact still works.
    expect(expires.getTime(), "security.txt has expired").toBeGreaterThan(Date.now());
    expect(expires.getTime()).toBeLessThan(Date.now() + 366 * 24 * 3600 * 1000);
  });

  it("points at a SECURITY.md that says how to report and how to verify a release", () => {
    expect(field("Policy")).toContain("SECURITY.md");
    const policy = readFileSync(root("SECURITY.md"), "utf8");
    expect(policy).toMatch(/private security advisory/i);
    expect(policy).toContain("gh attestation verify");
    expect(policy).toContain("registry-index.json");
  });
});
