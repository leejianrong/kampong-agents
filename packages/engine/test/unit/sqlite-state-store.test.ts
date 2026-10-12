import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";
import { runStateStoreContract } from "./state-store-contract.js";

const dir = mkdtempSync(join(tmpdir(), "kampong-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const paths = new Map<unknown, string>();

runStateStoreContract("SQLite (file)", {
  create(clock) {
    const path = join(dir, `s${n++}`, ".kampong", "state.db");
    const s = new SqliteStateStore({ path, clock });
    paths.set(s, path);
    return s;
  },
  createPeer(first, clock) {
    return new SqliteStateStore({ path: paths.get(first)!, clock });
  },
});

runStateStoreContract("SQLite (:memory:)", {
  create: (clock) => new SqliteStateStore({ path: ":memory:", clock }),
});

describe("SqliteStateStore persistence", () => {
  it("creates the .kampong directory and survives reopen", async () => {
    const path = join(dir, "persist", ".kampong", "state.db");
    const a = new SqliteStateStore({ path });
    await a.put("pending:1", { step: 3 });
    await a.close();
    expect(existsSync(path)).toBe(true);
    const b = new SqliteStateStore({ path });
    expect(await b.get("pending:1")).toEqual({ step: 3 });
    await b.close();
  });
});

describe("SqliteStateStore across processes", () => {
  it("concurrent putIfAbsent from separate processes yields exactly one winner", async () => {
    const path = join(dir, "multi", ".kampong", "state.db");
    // Seed the schema, then race real child processes using the built class
    // (the unit run follows `npm run build`, per AGENTS.md).
    await new SqliteStateStore({ path }).close();
    const entry = new URL("../../dist/sqlite-state-store.js", import.meta.url).href;
    const child = `
      import { SqliteStateStore } from ${JSON.stringify(entry)};
      const s = new SqliteStateStore({ path: ${JSON.stringify(path)} });
      const won = await s.putIfAbsent("lock", process.pid);
      await s.close();
      console.log(won ? "WON" : "LOST");
    `;
    const outputs = await Promise.all(Array.from({ length: 6 }, () => runNode(child)));
    expect(outputs.filter((o) => o.trim() === "WON")).toHaveLength(1);
    expect(outputs.filter((o) => o.trim() === "LOST")).toHaveLength(5);
  });
});

function runNode(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err))));
  });
}
