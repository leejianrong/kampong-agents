import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  auditActionName,
  decodeCursor,
  encodeCursor,
  parseAuditLimit,
} from "../../../src/audit/audit.js";

describe("audit log helpers (KAM-66)", () => {
  it("names the routes people care about and falls back to the raw route", () => {
    expect(auditActionName("PUT", "/api/secrets/:name")).toBe("secret.set");
    expect(auditActionName("POST", "/api/runs/:id/approve")).toBe("approval.decide");
    expect(auditActionName("POST", "/api/something/new")).toBe("POST /api/something/new");
  });

  it("round-trips a cursor and rejects junk", () => {
    const at = new Date("2026-11-26T10:00:00.123Z");
    expect(decodeCursor(encodeCursor(at, "abc"))).toEqual({ at, id: "abc" });
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(decodeCursor(Buffer.from("garbage|x").toString("base64url"))).toBeUndefined();
  });

  it("defaults and caps the page size", () => {
    expect(parseAuditLimit(undefined)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(parseAuditLimit("0")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(parseAuditLimit("25")).toBe(25);
    expect(parseAuditLimit("99999")).toBe(MAX_AUDIT_LIMIT);
  });
});
