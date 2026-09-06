import { and, eq, sql } from "drizzle-orm";
import {
  applyPatchToSource,
  type ApplyPatchResult,
  type LayoutMap,
  type PatchOp,
  type SpecRepository,
  type SpecSummary,
} from "@kampong/spec";
import { layouts, specs } from "./schema.js";
import type { DbClient } from "./client.js";

// Postgres-backed `SpecRepository` (KAN-1224, ADR-0014). Implements exactly
// the same interface `packages/cli`'s filesystem-backed `SpecStore` does
// (packages/cli/src/spec-store.ts), against the `specs`/`layouts` tables
// KAN-1223 already defined (src/db/schema.ts) -- proven correct by running
// the same shared contract suite (packages/spec/test/integration/
// repository-contract.ts) both implementations are held to.
//
// Deliberately NOT wired into any HTTP route yet (that's KAN-1227) -- this
// class exists, compiles, and is verified against a real database
// (test/integration/db/spec-repository.test.ts), nothing more.
//
// Scoped at construction time to one (workspaceId, specId) pair, mirroring
// `SpecStore`'s own "constructed already pointed at one spec" shape rather
// than threading an id through every method call -- see
// `SpecRepository.list()`'s docstring in packages/spec for why `list()`
// still means something workspace-wide even though every other method here
// is single-spec-scoped.

export class SpecNotFoundError extends Error {
  constructor(specId: string, workspaceId: string) {
    super(`No spec "${specId}" found in workspace "${workspaceId}".`);
    this.name = "SpecNotFoundError";
  }
}

export class PgSpecRepository implements SpecRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly specId: string,
  ) {}

  async readSource(): Promise<string> {
    const row = await this.getSpecRow();
    return row.yamlSource;
  }

  async readLayout(): Promise<LayoutMap> {
    const [row] = await this.db
      .select({ layoutJson: layouts.layoutJson })
      .from(layouts)
      .where(and(eq(layouts.specId, this.specId), eq(layouts.workspaceId, this.workspaceId)));
    return (row?.layoutJson as LayoutMap | undefined) ?? {};
  }

  async writeLayout(layout: LayoutMap): Promise<void> {
    // No unique constraint on (workspace_id, spec_id) in KAN-1223's schema to
    // upsert against directly (`ON CONFLICT`) -- select-then-branch instead:
    // functionally equivalent for this repository's single-writer-per-spec
    // usage (kampong dev/run today, this card's own contract test), and
    // avoids adding a schema migration this card's brief doesn't ask for.
    const [existing] = await this.db
      .select({ id: layouts.id })
      .from(layouts)
      .where(and(eq(layouts.specId, this.specId), eq(layouts.workspaceId, this.workspaceId)));

    if (existing) {
      await this.db.update(layouts).set({ layoutJson: layout }).where(eq(layouts.id, existing.id));
    } else {
      await this.db
        .insert(layouts)
        .values({ workspaceId: this.workspaceId, specId: this.specId, layoutJson: layout });
    }
  }

  /** Validates a patch against a fresh read before writing; an invalid mutation never reaches the database. */
  async applyPatchAndSave(ops: PatchOp[]): Promise<ApplyPatchResult> {
    const source = await this.readSource();
    const result = applyPatchToSource(source, ops);
    if (!result.success) {
      return result;
    }

    await this.db
      .update(specs)
      .set({ yamlSource: result.source, version: sql`${specs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(specs.id, this.specId), eq(specs.workspaceId, this.workspaceId)));

    return result;
  }

  /** Every spec row in this repository's workspace -- see `SpecRepository.list()`'s docstring for why this is genuinely workspace-wide, unlike every other method here. */
  async list(): Promise<SpecSummary[]> {
    const rows = await this.db
      .select({ id: specs.id, name: specs.name })
      .from(specs)
      .where(eq(specs.workspaceId, this.workspaceId));
    return rows;
  }

  private async getSpecRow(): Promise<{ yamlSource: string }> {
    const [row] = await this.db
      .select({ yamlSource: specs.yamlSource })
      .from(specs)
      .where(and(eq(specs.id, this.specId), eq(specs.workspaceId, this.workspaceId)));
    if (!row) {
      throw new SpecNotFoundError(this.specId, this.workspaceId);
    }
    return row;
  }

  /**
   * Inserts a new `specs` row (`workspaceId` must already exist -- workspace creation itself is
   * out of this card's scope) and returns a `PgSpecRepository` scoped to it. Not part of the
   * `SpecRepository` interface (the filesystem-backed implementation has no equivalent -- a spec
   * file "exists" the moment it's written to disk by any means) -- a construction/seeding helper
   * this card's own tests use, and that KAN-1227's real spec-CRUD routes will build their own
   * version of on top of the `specs` table directly.
   */
  static async create(
    db: DbClient,
    workspaceId: string,
    name: string,
    yamlSource: string,
  ): Promise<PgSpecRepository> {
    const [row] = await db
      .insert(specs)
      .values({ workspaceId, name, yamlSource })
      .returning({ id: specs.id });
    if (!row) {
      throw new Error("Insert into specs did not return an id.");
    }
    return new PgSpecRepository(db, workspaceId, row.id);
  }
}
