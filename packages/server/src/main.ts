#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";

// The process entry point the Dockerfile's runtime stage actually runs
// (CMD ["node", "packages/server/dist/main.js"]) -- kept separate from
// index.ts (the library barrel) for the same reason packages/cli splits
// cli.ts from index.ts: importing index.ts must never start a listening
// server, only running this file does.

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";

/**
 * Locates the canvas app's built static assets, same idea (and same
 * `@kampong/canvas-app` real-module-resolution reasoning) as
 * packages/cli/src/cli.ts's `resolveCanvasDistDir` -- duplicated rather than
 * shared because packages/cli is out of scope to modify for this card
 * (KAN-1221), and the two packages otherwise have no reason to depend on
 * each other. `require.resolve` finds `@kampong/canvas-app`'s `package.json`
 * regardless of whether the workspace dependency is a symlink (local dev) or
 * a real copy (a production install of this package's own node_modules) --
 * the directory containing it is what matters, not how it got there.
 */
function resolveCanvasDistDir(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@kampong/canvas-app/package.json");
  } catch {
    throw new Error(
      "Could not locate the @kampong/canvas-app workspace package. This normally means " +
        "dependencies aren't installed correctly -- run `npm install` from the repo root.",
    );
  }
  const distDir = join(dirname(pkgPath), "dist");
  if (!existsSync(distDir)) {
    throw new Error(
      `Canvas assets not found at ${distDir}. Build them first -- run \`npm run build\` from ` +
        `the repo root (this runs \`vite build\` for apps/canvas as part of the root build).`,
    );
  }
  return distDir;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  const host = process.env["HOST"] ?? DEFAULT_HOST;

  const staticDir = resolveCanvasDistDir();
  const app = createServer({ staticDir });

  await app.listen({ port, host });
  console.log(`kampong server listening at http://${host}:${port}`);
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `kampong-server: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
