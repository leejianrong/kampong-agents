import { spawnSync } from "node:child_process";
const names = [
  "fine",
  "recursion",
  "loop1m",
  "quadratic",
  "redos",
  "redosReplace",
  "padBomb",
  "rangeBomb",
  "doubling",
  "joinBomb",
];
for (const mode of ["raw", "guarded"]) {
  console.log(`\n== ${mode}`);
  for (const name of names) {
    const r = spawnSync("node", ["--max-old-space-size=512", "case.mjs", name, mode], {
      timeout: 25000,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0)
      console.log(
        name.padEnd(13),
        r.error
          ? "KILLED after 25s (no result)"
          : `exit ${r.status}: ${(r.stderr.split("\n").find((l) => /Error|heap|memory/i.test(l)) ?? "").slice(0, 70)}`,
      );
    else console.log(r.stdout.trim());
  }
}
