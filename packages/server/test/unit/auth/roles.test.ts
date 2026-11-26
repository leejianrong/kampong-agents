import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, can, rolesOf } from "../../../src/auth/roles.js";

describe("workspace roles (KAM-64, KAM-328)", () => {
  it("an admin holds every permission", () => {
    for (const p of PERMISSIONS) expect(can("admin", p)).toBe(true);
  });

  it("a viewer can read and nothing else", () => {
    for (const p of PERMISSIONS) {
      expect(can("viewer", p)).toBe(["spec:read", "run:read", "deployment:read"].includes(p));
    }
  });

  it("an approver reads and decides approvals, and changes nothing else", () => {
    expect(can("approver", "approval:resolve")).toBe(true);
    expect(can("approver", "spec:read")).toBe(true);
    for (const p of [
      "spec:write",
      "run:start",
      "deployment:manage",
      "secret:read",
      "secret:write",
    ] as const)
      expect(can("approver", p)).toBe(false);
  });

  it("an editor builds, runs, deploys and approves, but cannot touch secrets or model keys", () => {
    for (const p of ["spec:write", "run:start", "deployment:manage", "approval:resolve"] as const)
      expect(can("editor", p)).toBe(true);
    for (const p of ["secret:write", "byok:read", "byok:write"] as const)
      expect(can("editor", p)).toBe(false);
  });

  it("keeps Better Auth's own roles working: owner is an admin, member is an editor", () => {
    expect(rolesOf("owner")).toEqual(["admin"]);
    expect(rolesOf("member")).toEqual(["editor"]);
  });

  it("grants the union of a comma-separated role and ignores unknown names", () => {
    expect(rolesOf("viewer, approver").sort()).toEqual(["approver", "viewer"]);
    expect(can("viewer,approver", "approval:resolve")).toBe(true);
    expect(rolesOf("superuser")).toEqual([]);
    expect(can("superuser", "spec:read")).toBe(false);
    expect(can("", "spec:read")).toBe(false);
    expect(can(null, "spec:read")).toBe(false);
  });

  it("every role is in the table and every listed permission is a known one", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    for (const list of Object.values(ROLE_PERMISSIONS))
      for (const p of list) expect(PERMISSIONS).toContain(p);
  });
});
