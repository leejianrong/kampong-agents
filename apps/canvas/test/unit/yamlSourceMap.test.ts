import { describe, expect, it } from "vitest";
import { buildYamlSourceMap, nodeAtLine } from "../../src/yamlSourceMap.js";

const SPEC = `version: "1.1"
agent:
  id: a1
  name: A
  role: r
  goal: g
  trigger:
    type: schedule
    every: 1h
  tools:
    - name: t1
      type: http
      url: https://x.test
    - name: t2
      type: http
      url: https://y.test
  workflow:
    - step: first
      action: do it
    - step: each
      foreach:
        items: "{{ vars.xs }}"
        as: x
        steps:
          - step: inner
            action: inner work
    - step: route
      branch:
        if: "{{ first.ok }}"
        then:
          - step: yes
            action: say yes
        else:
          - step: no
            action: say no
    - step: last
      action: done
  guardrails:
    max_steps: 3
`;

describe("buildYamlSourceMap", () => {
  const map = buildYamlSourceMap(SPEC);
  const text = SPEC.split("\n");

  it("maps top-level steps to their own lines", () => {
    expect(map.get("workflow:first")).toEqual({ start: 18, end: 19 });
    expect(text[17]).toContain("step: first");
    expect(map.get("workflow:last")).toEqual({ start: 36, end: 37 });
  });

  it("maps a foreach step to the whole loop and its body step inside it", () => {
    const loop = map.get("workflow:each")!;
    const inner = map.get("workflow:inner")!;
    expect(text[loop.start - 1]).toContain("step: each");
    expect(text[loop.end - 1]).toContain("inner work");
    expect(inner.start).toBe(loop.end - 1);
    expect(inner.end).toBe(loop.end);
  });

  it("resolves branch arms", () => {
    expect(text[map.get("workflow:yes")!.start - 1]).toContain("step: yes");
    expect(text[map.get("workflow:no")!.end - 1]).toContain("say no");
    expect(text[map.get("workflow:route")!.start - 1]).toContain("step: route");
  });

  it("maps tools, the trigger (the agent node) and guardrails", () => {
    expect(map.get("tool:t2")).toEqual({ start: 14, end: 16 });
    expect(map.get("agent:a1")).toEqual({ start: 7, end: 9 });
    expect(text[map.get("guardrails:a1")!.start - 1]).toContain("guardrails:");
    expect(map.get("guardrails:a1")!.end).toBe(39);
  });

  it("falls back to the identity lines when there is no trigger", () => {
    const m = buildYamlSourceMap(
      'version: "1.0"\nagent:\n  id: z\n  name: Z\n  role: r\n  goal: g\n  workflow: []\n',
    );
    expect(m.get("agent:z")).toEqual({ start: 3, end: 6 });
  });

  it("resolves switch cases and default", () => {
    const m = buildYamlSourceMap(`version: "1.1"
agent:
  id: s
  name: S
  role: r
  goal: g
  workflow:
    - step: sw
      branch:
        switch: "{{ x }}"
        cases:
          bug:
            - step: on_bug
              action: a
        default:
          - step: other
            action: b
`);
    expect(m.get("workflow:on_bug")).toEqual({ start: 13, end: 14 });
    expect(m.get("workflow:other")).toEqual({ start: 16, end: 17 });
  });

  it("returns an empty map for broken or unrelated YAML", () => {
    expect(buildYamlSourceMap("::: [").size).toBe(0);
    expect(buildYamlSourceMap("").size).toBe(0);
    expect(buildYamlSourceMap("- a\n- b\n").size).toBe(0);
  });
});

describe("nodeAtLine", () => {
  const map = buildYamlSourceMap(SPEC);
  it("prefers the tightest node, so a body step beats its foreach", () => {
    expect(nodeAtLine(map, map.get("workflow:inner")!.start)).toBe("workflow:inner");
    expect(nodeAtLine(map, map.get("workflow:each")!.start)).toBe("workflow:each");
    expect(nodeAtLine(map, map.get("workflow:no")!.start)).toBe("workflow:no");
  });
  it("is null for a line no node owns", () => {
    expect(nodeAtLine(map, 1)).toBeNull();
    expect(nodeAtLine(map, 4)).toBeNull();
  });
});
