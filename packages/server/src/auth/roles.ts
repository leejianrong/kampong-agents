// KAM-64 / KAM-328: the four workspace roles and what each may do, in one place. A route names the permission
// it needs (`authorizeWorkspace(..., "spec:write")`); this table decides which roles hold it.
//
// Better Auth's organization plugin stores a member's role as text in `workspace_members.role`. Its own
// defaults are "owner" and "member"; both keep working: owner is an admin, member is an editor, so a workspace
// created before roles existed behaves as it did for its owner and loses nothing for its members except the
// admin-only actions below. A comma-separated value (several roles) grants the union.

export const ROLES = ["admin", "editor", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "spec:read",
  "spec:write",
  "run:read",
  "run:start",
  "approval:resolve",
  "deployment:read",
  "deployment:manage",
  "secret:read",
  "secret:write",
  "byok:read",
  "byok:write",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["spec:read", "run:read", "deployment:read"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Everything, including the workspace's secrets, model keys and audit log.
  admin: PERMISSIONS,
  // Builds, runs, deploys and approves. Cannot read or change secrets or model keys.
  editor: [
    ...READ,
    "spec:write",
    "run:start",
    "approval:resolve",
    "deployment:manage",
    "secret:read",
  ],
  // Reviews: reads everything an author can see, and decides approvals. Changes nothing else.
  approver: [...READ, "approval:resolve"],
  // Read only.
  viewer: READ,
};

const ALIASES: Record<string, Role> = { owner: "admin", member: "editor" };

/** The roles a stored role value grants, ignoring names this module does not know. */
export function rolesOf(stored: string | null | undefined): Role[] {
  const out = new Set<Role>();
  for (const part of (stored ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    const role =
      ALIASES[name] ?? ((ROLES as readonly string[]).includes(name) ? (name as Role) : undefined);
    if (role) out.add(role);
  }
  return [...out];
}

/** True when any of the stored role's roles holds the permission. An unknown or empty role holds nothing. */
export function can(stored: string | null | undefined, permission: Permission): boolean {
  return rolesOf(stored).some((r) => ROLE_PERMISSIONS[r].includes(permission));
}
