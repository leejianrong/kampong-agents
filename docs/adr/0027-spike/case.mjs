// Runs one expression either unguarded or with the proposed guards; prints one JSON line.
import jsonata from "jsonata";
const [, , name, mode] = process.argv;
const CASES = {
  recursion: "($f := function($x){$f($x+1)}; $f(0))",
  loop1m: "$reduce([1..1000000], function($a,$b){$a+$b})",
  quadratic: "$count($map([1..4000], function($v){ $count($map([1..4000], function($w){$w})) }))",
  redos: '$match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", /^(a+)+$/)',
  redosReplace: '$replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", /(a+)+$/, "x")',
  padBomb: '$pad("x", 400000000)',
  rangeBomb: "$count([1..10000000])",
  doubling: '$length($reduce([1..40], function($a){ $a & $a }, "x"))',
  joinBomb: '$length($join($map([1..2000000], function($v){"xxxxxxxxxx"})))',
  fine: "$sum(items.(price * qty))",
};
const input = { items: [{ price: 2.5, qty: 3 }] };
const LIMITS = { ms: 200, steps: 500_000, depth: 400, str: 1_000_000, arr: 200_000 };

const src = CASES[name];
const t0 = performance.now();
let outcome;
try {
  const expr = jsonata(src);
  const bindings = {};
  if (mode === "guarded") {
    // Regex literals are native and cannot be interrupted, so they are rejected before evaluation.
    let hasRegex = false;
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "regex") hasRegex = true;
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(expr.ast());
    if (hasRegex)
      throw Object.assign(new Error("regular expressions are not available"), { code: "KREGEX" });
    let steps = 0,
      depth = 0;
    const start = Date.now();
    const check = () => {
      if (Date.now() - start > LIMITS.ms)
        throw Object.assign(new Error(`took longer than ${LIMITS.ms}ms`), { code: "KTIME" });
      if (steps > LIMITS.steps)
        throw Object.assign(new Error(`more than ${LIMITS.steps} steps`), { code: "KSTEPS" });
      if (depth > LIMITS.depth)
        throw Object.assign(new Error(`nested deeper than ${LIMITS.depth}`), { code: "KDEPTH" });
    };
    expr.assign(Symbol.for("jsonata.__evaluate_entry"), (_e, _i, _env) => {
      steps++;
      depth++;
      check();
    });
    expr.assign(Symbol.for("jsonata.__evaluate_exit"), (e, i, env, result) => {
      depth--;
      check();
      if (typeof result === "string" && result.length > LIMITS.str)
        throw Object.assign(new Error("string too long"), { code: "KSIZE" });
      if (Array.isArray(result) && result.length > LIMITS.arr)
        throw Object.assign(new Error("list too long"), { code: "KSIZE" });
    });
    // $pad allocates before any hook can see the result: cap its width up front.
    const pad = await jsonata("$pad").evaluate({});
    bindings.pad = (s, w, c) => {
      if (Math.abs(w) > LIMITS.str)
        throw Object.assign(new Error("pad width too large"), { code: "KSIZE" });
      return pad(s, w, c);
    };
  }
  const r = await expr.evaluate(input, bindings);
  outcome = { result: JSON.stringify(r)?.slice(0, 30) };
} catch (e) {
  outcome = { error: `${e.code ?? e.name}: ${String(e.message).slice(0, 60)}` };
}
console.log(
  JSON.stringify({
    name,
    mode,
    ms: Math.round(performance.now() - t0),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    ...outcome,
  }),
);
