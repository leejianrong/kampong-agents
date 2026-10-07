import jsonata from "jsonata";
for (const [label, src] of [
  ["tail call (JSONata optimises it)", "($f := function($x){$x < 100000 ? $f($x+1) : $x}; $f(0))"],
  ["non-tail, 5000 deep", "($f := function($x){$x < 5000 ? 1 + $f($x+1) : 0}; $f(0))"],
]) {
  for (const stack of [undefined, 400]) {
    const t0 = performance.now();
    try {
      const r = await jsonata(src, { stack, timeout: 2000 }).evaluate({});
      console.log(
        label.padEnd(36),
        `stack=${stack}`.padEnd(10),
        "result",
        r,
        Math.round(performance.now() - t0) + "ms",
      );
    } catch (e) {
      console.log(
        label.padEnd(36),
        `stack=${stack}`.padEnd(10),
        "error",
        e.code ?? e.name,
        String(e.message).slice(0, 50),
        Math.round(performance.now() - t0) + "ms",
      );
    }
  }
}
