import jsonata from "jsonata";
const where = (src, pos) => {
  const before = src.slice(0, pos);
  const line = before.split("\n").length;
  return `line ${line}, col ${pos - before.lastIndexOf("\n")}`;
};
const CASES = [
  ["syntax: unclosed paren", "$count(items"],
  ["syntax: stray token", "a + * b"],
  ["syntax: bad string", '"unterminated'],
  ["syntax: multi-line", "a +\n  b +\n  )"],
  ["syntax: empty", ""],
  ["runtime: unknown function", "$nope(1)"],
  ["runtime: type error", '"a" + 1'],
  ["runtime: bad argument", "$count(1, 2, 3)"],
  ["runtime: compare mismatch", 'a < "x"'],
  ["runtime: not a function", "a(1)"],
  ["runtime: in a nested expr", "$sum(items.(price * $bogus(qty)))"],
  ["silent: missing path", "alerts[0].labl.alertname"],
  ["silent: wrong index", "items[9].name"],
  ["silent: wrong type for number", "$abs(label)"],
];
const input = {
  a: 1,
  items: [{ price: 2, qty: 3 }],
  label: "x",
  alerts: [{ labels: { alertname: "x" } }],
};
for (const [label, src] of CASES) {
  let out;
  try {
    const expr = jsonata(src);
    const r = await expr.evaluate(input);
    out = `no error; result = ${JSON.stringify(r)}`;
  } catch (e) {
    const isError = e instanceof Error;
    out = `${e.code} ${JSON.stringify(String(e.message).slice(0, 60))}  position=${e.position ?? "none"}${e.position !== undefined ? " (" + where(src, e.position) + ")" : ""}  ${isError ? "" : "[not an Error instance]"}`;
  }
  console.log(label.padEnd(30), out);
}
