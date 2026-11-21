import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// KAM-201: the dark scheme in theme.css. It must define every colour role the light scheme does (a role left out
// would silently fall back to a light value on a dark surface) and keep text at WCAG AA (4.5:1) in both schemes.

const css = readFileSync(join(process.cwd(), "apps/canvas/src/theme.css"), "utf8");

type Tokens = Record<string, string>;
const light: Tokens = {};
const dark: Tokens = {};
for (const m of css.matchAll(
  /(@media \(prefers-color-scheme: dark\) \{\s*)?:root \{(.*?)\n\s*\}/gs,
)) {
  const target = m[1] ? dark : light;
  for (const [, name, value] of m[2]!.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    target[name!] = value!;
  }
}
const darkResolved: Tokens = { ...light, ...dark };

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const roles = (t: Tokens): string[] => Object.keys(t).filter((k) => k.startsWith("md-sys-color-"));
const SURFACES = [
  "surface",
  "surface-container-lowest",
  "surface-container-low",
  "surface-container",
  "surface-container-high",
  "surface-container-highest",
];
const KINDS = ["trigger", "ai", "tool", "data", "flow", "approval", "guard"];
const pairs: Array<[string, string]> = [
  ...["primary", "secondary", "tertiary", "error"].flatMap((r): Array<[string, string]> => [
    [`md-sys-color-on-${r}`, `md-sys-color-${r}`],
    [`md-sys-color-on-${r}-container`, `md-sys-color-${r}-container`],
  ]),
  ...SURFACES.flatMap((s): Array<[string, string]> => [
    ["md-sys-color-on-surface", `md-sys-color-${s}`],
    ["md-sys-color-on-surface-variant", `md-sys-color-${s}`],
    ["md-sys-color-primary", `md-sys-color-${s}`],
    ["md-sys-color-error", `md-sys-color-${s}`],
  ]),
  ["md-sys-color-on-warning-container", "md-sys-color-warning-container"],
  ["md-sys-color-inverse-on-surface", "md-sys-color-inverse-surface"],
  ...KINDS.map((k): [string, string] => [`kg-${k}-fg`, `kg-${k}-bg`]),
];

describe("dark theme (KAM-201)", () => {
  it("defines every colour role and node category the light scheme does", () => {
    expect(roles(light).length).toBeGreaterThan(20);
    for (const name of [...roles(light), ...KINDS.flatMap((k) => [`kg-${k}-bg`, `kg-${k}-fg`])]) {
      expect(dark, `${name} missing from the dark scheme`).toHaveProperty(name);
    }
  });

  it.each([
    ["light", light],
    ["dark", darkResolved],
  ])("keeps text at 4.5:1 in the %s scheme", (_name, tokens) => {
    for (const [fg, bg] of pairs) {
      expect(contrast(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dark surface dark and each category distinct from the others", () => {
    expect(luminance(dark["md-sys-color-surface"]!)).toBeLessThan(0.05);
    expect(new Set(KINDS.map((k) => dark[`kg-${k}-bg`])).size).toBe(KINDS.length);
  });
});
