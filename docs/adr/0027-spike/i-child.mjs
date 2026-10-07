import { spawnSync } from "node:child_process";
const one = (src, mb) => {
  const t0 = performance.now();
  const r = spawnSync(
    "node",
    [
      `--max-old-space-size=${mb}`,
      "-e",
      `import("jsonata").then(async ({default:j})=>{console.log(JSON.stringify(await j(${JSON.stringify(src)}).evaluate({})))})`,
    ],
    { timeout: 20000, encoding: "utf8" },
  );
  return {
    status: r.status,
    signal: r.signal,
    out: r.stdout.trim().slice(0, 20),
    ms: Math.round(performance.now() - t0),
  };
};
console.log("fine      ", JSON.stringify(one("1+1", 64)));
console.log("range 1e7 ", JSON.stringify(one("$count([1..10000000])", 64)));
console.log(
  "join bomb ",
  JSON.stringify(one('$length($join($map([1..2000000], function($v){"xxxxxxxxxx"})))', 64)),
);
console.log("parent (this process) is still running and healthy");
