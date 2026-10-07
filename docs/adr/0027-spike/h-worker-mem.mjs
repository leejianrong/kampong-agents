import { Worker } from "node:worker_threads";
const run = (src, limits) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const w = new Worker(
      `import("jsonata").then(async ({default: j}) => { const {parentPort, workerData} = await import("node:worker_threads"); try { parentPort.postMessage({ok: String(await j(workerData).evaluate({})).slice(0,20)}) } catch(e){ parentPort.postMessage({err: e.code}) } });`,
      { eval: true, workerData: src, resourceLimits: limits },
    );
    w.once("message", (m) => {
      w.terminate();
      resolve({ ...m, ms: Math.round(performance.now() - t0) });
    });
    w.once("error", (e) =>
      resolve({
        workerError: e.code ?? e.message.slice(0, 40),
        ms: Math.round(performance.now() - t0),
      }),
    );
  });
const limits = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 };
console.log("fine      ", JSON.stringify(await run("1+1", limits)));
console.log("range 1e7 ", JSON.stringify(await run("$count([1..10000000])", limits)));
console.log(
  "join bomb ",
  JSON.stringify(
    await run('$length($join($map([1..2000000], function($v){"xxxxxxxxxx"})))', limits),
  ),
);
console.log("main thread survives:", process.memoryUsage().rss / 1048576 < 400);
