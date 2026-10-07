import jsonata from "jsonata";
import { spawnSync } from "node:child_process";
if (process.argv[2]) {
  const [, , name, src, timeout, stack] = process.argv;
  const t0 = performance.now();
  try {
    const r = await jsonata(src, { timeout: Number(timeout), stack: Number(stack) }).evaluate({});
    console.log(
      JSON.stringify({
        name,
        ms: Math.round(performance.now() - t0),
        result: JSON.stringify(r)?.slice(0, 20),
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        name,
        ms: Math.round(performance.now() - t0),
        error: `${e.code}: ${e.message}`.slice(0, 80),
        position: e.position,
      }),
    );
  }
} else {
  const cases = {
    recursion: "($f := function($x){$f($x+1)}; $f(0))",
    loop1m: "$reduce([1..1000000], function($a,$b){$a+$b})",
    quadratic: "$count($map([1..4000], function($v){ $count($map([1..4000], function($w){$w})) }))",
    redos: '$match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", /^(a+)+$/)',
  };
  for (const [n, s] of Object.entries(cases)) {
    const r = spawnSync("node", ["--max-old-space-size=512", "c-builtin.mjs", n, s, "200", "400"], {
      timeout: 25000,
      encoding: "utf8",
    });
    console.log(r.error ? `${n} KILLED after 25s (not interrupted)` : r.stdout.trim());
  }
}
