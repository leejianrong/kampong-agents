import jsonata from "jsonata";

const FORBIDDEN = ["now", "millis", "random", "shuffle", "eval"];
const run = async (src, input = {}, bindings = {}) => {
  try {
    return { ok: await jsonata(src).evaluate(input, bindings) };
  } catch (e) {
    return { err: `${e.code ?? e.name}: ${e.message}` };
  }
};

console.log("== 1. What is non-deterministic out of the box");
for (const src of ["$now()", "$millis()", "$random()", "$shuffle([1,2,3,4,5,6])", '$eval("1+1")']) {
  const a = await run(src),
    b = await run(src);
  console.log(
    src.padEnd(26),
    JSON.stringify(a.ok ?? a.err).slice(0, 40),
    a.ok !== undefined && JSON.stringify(a) !== JSON.stringify(b)
      ? "  <-- differs between runs"
      : "",
  );
}

console.log("\n== 2. Static rejection by walking the AST (also catches aliasing)");
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object") walk(v, visit);
  }
}
const forbiddenIn = (src) => {
  const found = new Set();
  walk(jsonata(src).ast(), (n) => {
    if (n.type === "variable" && FORBIDDEN.includes(n.value)) found.add(n.value);
  });
  return [...found];
};
for (const src of [
  "$now()",
  "($f := $now; $f())",
  "$map([1,2], $random)",
  "$eval('1')",
  "$sum([1,2]) + $abs(-3)",
  "a.$now",
]) {
  console.log(src.padEnd(26), JSON.stringify(forbiddenIn(src)));
}

console.log("\n== 3. Defence in depth: shadow the builtins with bindings that throw");
const shadows = Object.fromEntries(
  FORBIDDEN.map((n) => [
    n,
    () => {
      throw new Error(`$${n} is not available`);
    },
  ]),
);
for (const src of [
  "$now()",
  "($f := $now; $f())",
  "$map([1,2], $random)",
  "$shuffle([1,2])",
  '$eval("1+1")',
]) {
  console.log(src.padEnd(26), JSON.stringify((await run(src, {}, shadows)).err ?? "evaluated"));
}

console.log("\n== 4. Repeatability over a corpus (200 evaluations each, byte-identical results)");
const corpus = [
  ["alerts[0].labels.alertname", { alerts: [{ labels: { alertname: "HighCPU" } }] }],
  ["$abs(change) >= vars.threshold", { change: -7, vars: { threshold: 5 } }],
  ["$count(plan.specialists) = 0", { plan: { specialists: [] } }],
  ["$sort(series, function($a,$b){$a.t < $b.t})[-2]", { series: [{ t: 3 }, { t: 1 }, { t: 2 }] }],
  [
    "$sum(items.(price * qty))",
    {
      items: [
        { price: 2.5, qty: 3 },
        { price: 1, qty: 4 },
      ],
    },
  ],
  ["$string(1/3) & $formatNumber(1234.5, '#,##0.00')", {}],
  ["$fromMillis(86400000, '[Y0001]-[M01]-[D01]')", {}],
  ["$toMillis('2026-10-07T00:00:00Z')", {}],
  ["$distinct(files.path)", { files: [{ path: "a" }, { path: "b" }, { path: "a" }] }],
  ["$keys({'b':1,'a':2})", {}],
  ["$sift({'b':1,'a':2}, function($v){$v>1})", {}],
];
let drift = 0;
for (const [src, input] of corpus) {
  const first = JSON.stringify(await jsonata(src).evaluate(input));
  for (let i = 0; i < 200; i++)
    if (JSON.stringify(await jsonata(src).evaluate(input)) !== first) drift++;
  console.log(src.slice(0, 60).padEnd(62), first.slice(0, 40));
}
console.log("drift across all runs:", drift);

console.log("\n== 5. Host access: can an expression reach Object.prototype / globals?");
for (const src of [
  "$.constructor",
  '$."__proto__"',
  "constructor",
  "$.toString",
  "a.constructor",
  "$type($.constructor)",
]) {
  const r = await run(src, { a: {} });
  console.log(
    src.padEnd(26),
    JSON.stringify(r.ok === undefined ? (r.err ?? "undefined") : typeof r.ok),
  );
}
console.log(
  "process/global names as variables:",
  JSON.stringify((await run("$process", {})).ok ?? "undefined"),
  JSON.stringify((await run("$globalThis", {})).ok ?? "undefined"),
);
