import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecFileWatcher, type FileWatchEvent } from "../../src/file-watcher.js";

function waitForEvent(watcher: SpecFileWatcher, timeoutMs = 5000): Promise<FileWatchEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for a watcher event")),
      timeoutMs,
    );
    watcher.once("change", (event: FileWatchEvent) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe("SpecFileWatcher", () => {
  let dir: string;
  let path: string;
  let watcher: SpecFileWatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-file-watcher-"));
    path = join(dir, "agent.yaml");
    writeFileSync(path, 'version: "1.0"\n');
    watcher = new SpecFileWatcher(path);
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a 'reload' event for an external change with no mutation in flight", async () => {
    const pending = waitForEvent(watcher);
    writeFileSync(path, 'version: "1.0"\nagent:\n  id: x\n');
    const event = await pending;

    expect(event.type).toBe("reload");
  });

  it("emits a 'conflict' event when the external write lands during a local mutation", async () => {
    watcher.beginMutation();
    const pending = waitForEvent(watcher);
    writeFileSync(path, 'version: "1.0"\nagent:\n  id: external-edit\n');
    const event = await pending;

    expect(event.type).toBe("conflict");
  });

  it("does not emit an event for the watcher's own recorded write echoing back", async () => {
    const writtenSource = 'version: "1.0"\nagent:\n  id: self-write\n';
    watcher.beginMutation();
    writeFileSync(path, writtenSource);
    watcher.endMutation(writtenSource);

    let sawEvent = false;
    watcher.once("change", () => {
      sawEvent = true;
    });

    // Give the fs watcher a moment to fire, if it's going to.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sawEvent).toBe(false);
  });

  // KAN-1184: fs.watch(filePath) watches an inode, not a filename. An
  // editor's atomic save (write a temp file, then rename() it over the
  // original path -- how Vim, many VS Code configs, and this session's own
  // file-edit tooling all save) replaces the inode at `path`. A watch on
  // the old inode used to go silent PERMANENTLY after the first such save --
  // it fired once for the rename, then never again, even for a later plain
  // in-place write. This must survive several atomic saves in a row, not
  // just recover from one.
  it("keeps firing for repeated atomic write-then-rename saves, not just the first", async () => {
    for (let i = 0; i < 4; i++) {
      const pending = waitForEvent(watcher);
      const tmpPath = `${path}.tmp-${i}`;
      writeFileSync(tmpPath, `version: "1.0"\nagent:\n  id: atomic-${i}\n`);
      renameSync(tmpPath, path);

      const event = await pending;
      expect(event.type).toBe("reload");
      expect(event.source).toContain(`atomic-${i}`);
    }
  });

  it("still fires for a plain in-place write after prior atomic-save renames", async () => {
    // Two atomic saves first, to land the watcher on a replaced inode --
    // exactly the state that used to break the *next* plain write too.
    for (let i = 0; i < 2; i++) {
      const pending = waitForEvent(watcher);
      const tmpPath = `${path}.tmp-${i}`;
      writeFileSync(tmpPath, `version: "1.0"\nagent:\n  id: atomic-${i}\n`);
      renameSync(tmpPath, path);
      await pending;
    }

    const pending = waitForEvent(watcher);
    writeFileSync(path, 'version: "1.0"\nagent:\n  id: plain-after-renames\n');
    const event = await pending;

    expect(event.type).toBe("reload");
    expect(event.source).toContain("plain-after-renames");
  });

  it("ignores directory events for unrelated sibling files (e.g. an editor's temp file)", async () => {
    let sawEvent = false;
    watcher.once("change", () => {
      sawEvent = true;
    });

    const siblingPath = join(dir, "unrelated.tmp");
    writeFileSync(siblingPath, "not the spec file");
    renameSync(siblingPath, join(dir, "unrelated.txt"));

    // Give the fs watcher a moment to fire, if it's (wrongly) going to.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sawEvent).toBe(false);
  });
});
