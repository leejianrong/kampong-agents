import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
