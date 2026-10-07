import jsonata from "jsonata";
import { Worker } from "node:worker_threads";

console.log("== stack option (D1011)");
try {
  await jsonata("($f := function($x){$x < 5000 ? $f($x+1) : $x}; $f(0))", {
    stack: 400,
    timeout: 2000,
  }).evaluate({});
} catch (e) {
  console.log(e.code, e.message.slice(0, 60));
}

console.log("\n== parser on pathologically nested source (no length cap)");
for (const depth of [1000, 5000, 20000, 100000]) {
  const src = "(".repeat(depth) + "1" + ")".repeat(depth);
  const t0 = performance.now();
  try {
    jsonata(src);
    console.log(`depth ${depth}`.padEnd(14), "parsed", Math.round(performance.now() - t0), "ms");
  } catch (e) {
    console.log(
      `depth ${depth}`.padEnd(14),
      "error:",
      e.code ?? e.name,
      String(e.message).slice(0, 50),
      Math.round(performance.now() - t0),
      "ms",
    );
  }
}

console.log("\n== RegexEngine hook (the extension point for a safe regex implementation)");
class NoRegex {
  constructor() {
    throw Object.assign(new Error("regular expressions are not available"), { code: "KREGEX" });
  }
}
try {
  await jsonata('$contains("abc", /b/)', { RegexEngine: NoRegex }).evaluate({});
} catch (e) {
  console.log(e.code, e.message);
}
console.log(
  "string patterns keep working:",
  await jsonata('$contains("abc", "b") and $split("a,b", ",")[1] = "b"').evaluate({}),
);

console.log("\n== hosted fallback: run in a worker and terminate on timeout (interrupts ReDoS)");
const evalInWorker = (src, limitMs) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const w = new Worker(
      `
    import("jsonata").then(async ({default: jsonata}) => {
      const { parentPort, workerData } = await import("node:worker_threads");
      try { parentPort.postMessage({ ok: await jsonata(workerData).evaluate({}) }); } catch (e) { parentPort.postMessage({ err: e.code + ": " + e.message }); }
    });`,
      { eval: true, workerData: src },
    );
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ killed: true, ms: Math.round(performance.now() - t0) });
    }, limitMs);
    w.once("message", (m) => {
      clearTimeout(timer);
      w.terminate();
      resolve({ ...m, ms: Math.round(performance.now() - t0) });
    });
  });
console.log("fine   ", JSON.stringify(await evalInWorker("1+1", 2000)));
console.log("fine#2 ", JSON.stringify(await evalInWorker("1+1", 2000)));
console.log(
  "redos  ",
  JSON.stringify(
    await evalInWorker('$match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", /^(a+)+$/)', 300),
  ),
);
