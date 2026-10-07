// Is there a useful subset a canvas form can edit, with a lossless round trip to text?
import jsonata from "jsonata";

const FUNCS = new Set([
  "abs",
  "count",
  "length",
  "sum",
  "max",
  "min",
  "round",
  "floor",
  "ceil",
  "lowercase",
  "uppercase",
  "string",
  "number",
  "exists",
  "not",
  "contains",
  "trim",
]);
const BIN = new Set(["+", "-", "*", "/", "%", "=", "!=", "<", ">", "<=", ">=", "and", "or", "&"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// AST -> form model (or null when outside the subset, with the reason).
function toModel(n) {
  switch (n.type) {
    case "number":
    case "string":
    case "value":
      return { k: "lit", v: n.value };
    case "path": {
      const steps = [];
      for (const s of n.steps) {
        if (
          s.type !== "name" ||
          s.stages?.some((st) => st.type !== "filter" || st.expr.type !== "number")
        )
          return fail(`path step "${s.value ?? s.type}" with a ${s.stages ? "predicate" : s.type}`);
        steps.push({ name: s.value, index: (s.stages ?? []).map((st) => st.expr.value) });
      }
      if (n.keepSingletonArray || n.steps.some((s) => s.keepArray)) return fail("[] array keeper");
      return { k: "ref", steps };
    }
    case "unary":
      if (n.value === "-") return wrap({ k: "neg" }, [n.expression]);
      return fail(`unary ${n.value}`);
    case "binary":
      return BIN.has(n.value)
        ? wrap({ k: "bin", op: n.value }, [n.lhs, n.rhs])
        : fail(`operator ${n.value}`);
    case "condition":
      return n.else
        ? wrap({ k: "if" }, [n.condition, n.then, n.else])
        : fail("condition without else");
    case "function":
      return n.procedure.type === "variable" && FUNCS.has(n.procedure.value)
        ? wrap({ k: "call", fn: n.procedure.value }, n.arguments)
        : fail(`function ${n.procedure.value ?? n.procedure.type}`);
    case "block":
      return n.expressions.length === 1
        ? toModel(n.expressions[0])
        : fail("block with several expressions");
    default:
      return fail(n.type);
  }
}
let reason;
const fail = (r) => {
  reason ??= r;
  return null;
};
function wrap(m, kids) {
  const a = kids.map(toModel);
  return a.includes(null) ? null : { ...m, a };
}

// form model -> text.
const q = (s) => (IDENT.test(s) ? s : "`" + s + "`");
function print(m, top = true) {
  switch (m.k) {
    case "lit":
      return typeof m.v === "string" ? JSON.stringify(m.v) : String(m.v);
    case "ref":
      return m.steps.map((s) => q(s.name) + s.index.map((i) => `[${i}]`).join("")).join(".");
    case "neg":
      return `-${print(m.a[0], false)}`;
    case "bin": {
      const t = `${print(m.a[0], false)} ${m.op} ${print(m.a[1], false)}`;
      return top ? t : `(${t})`;
    }
    case "if": {
      const t = `${print(m.a[0], false)} ? ${print(m.a[1], false)} : ${print(m.a[2], false)}`;
      return top ? t : `(${t})`;
    }
    case "call":
      return `$${m.fn}(${m.a.map((x) => print(x)).join(", ")})`;
  }
}

const strip = (n) =>
  JSON.parse(JSON.stringify(n, (k, v) => (k === "position" || k === "keepArray" ? undefined : v)));
const unblock = (n) =>
  Array.isArray(n)
    ? n.map(unblock)
    : n && typeof n === "object"
      ? n.type === "block" && n.expressions?.length === 1
        ? unblock(n.expressions[0])
        : Object.fromEntries(Object.entries(n).map(([k, v]) => [k, unblock(v)]))
      : n;
const norm = (src) => JSON.stringify(unblock(strip(jsonata(src).ast())));

const CORPUS = [
  // From the ADR-0027 demos and the V11 templates.
  "alerts[0].labels.alertname",
  "$abs(change) >= vars.threshold",
  "$count(plan.specialists) = 0",
  "trigger.body.pull_request.number",
  'severity = "critical" or $count(alerts) > 3',
  "price * qty + fee",
  "-delta < 0",
  "step.confidence >= 0.8",
  "$exists(trigger.body.repo)",
  '$lowercase(trigger.headers.`x-github-event`) = "pull_request"',
  "files[0].path",
  "$max(series.close) - $min(series.close)",
  'vars.region & "-" & vars.env',
  'ok ? "yes" : "no"',
  "($count(files) + 1) * 2",
  "$round(total / n)",
  "not($exists(error))",
  // Beyond a form: shown as text, still valid.
  "$sort(series, function($a,$b){$a.t < $b.t})[-1]",
  "items[price > 3].name",
  "$map(files, function($f){$f.path})",
  "$sum(items.(price * qty))",
  '{"title": name, "n": $count(items)}',
  'files.path ~> $join(", ")',
  "$.items[0]",
  "**.id",
  "$distinct(files.path)",
  "$match(body, /fix (\\d+)/).groups[0]",
  "($x := a + 1; $x * 2)",
];

let inSubset = 0,
  roundTripOk = 0;
for (const src of CORPUS) {
  reason = undefined;
  const model = toModel(jsonata(src).ast());
  if (!model) {
    console.log("text only ".padEnd(11), src.slice(0, 58).padEnd(60), "(" + reason + ")");
    continue;
  }
  inSubset++;
  const text = print(model);
  const same = norm(text) === norm(src);
  if (same) roundTripOk++;
  console.log(
    (same ? "form  ✓   " : "form  ✗   ").padEnd(11),
    src.slice(0, 58).padEnd(60),
    same ? (text === src ? "" : "→ " + text) : `→ ${text}  !! AST differs`,
  );
}
console.log(
  `\n${inSubset}/${CORPUS.length} expressions fit the form subset; ${roundTripOk}/${inSubset} round-trip to an identical AST.`,
);
