// Packs the five packages that make up the `kampong` command into tarballs (KAM-288), in the order they depend on
// each other, so the tool can be installed on a machine that has no clone of this repo:
//
//   npm run pack:release             # builds, then writes release/*.tgz
//   mkdir try && cd try && npm init -y
//   npm install ../release/*.tgz     # all five on one line
//   npx kampong dev
//
// Nothing here publishes anything. Publishing to a registry (the package names, the account, the licence of the
// core) is the owner's decision, so the packages stay `private` and this only writes tarballs.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(process.argv[2] ?? join(root, "release"));
const PACKAGES = [
  "packages/spec",
  "packages/engine",
  "packages/exporter",
  "apps/canvas",
  "packages/cli",
];

mkdirSync(dest, { recursive: true });
const files = [];
for (const dir of PACKAGES) {
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", dest], {
    cwd: join(root, dir),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  files.push(join(dest, out));
}
console.log(files.join("\n"));
