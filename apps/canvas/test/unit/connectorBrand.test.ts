import { describe, expect, it } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { brandsFromCatalog, connectorBrands } from "../../src/connectorBrand.js";
import { cardInfo } from "../../src/nodeCard.js";

// KAM-247: a connector is a letter on a colour.
const SPEC = `version: "1.1"
agent:
  id: c
  name: C
  role: R
  goal: G
  tools:
    - name: post
      action: component
      use: kampong/slack@1.0.0
      op: post_message
    - name: other
      action: component
      use: acme/widgets@1.0.0
      op: go
    - name: mail
      action: gmail_send
      token: "\${GMAIL_TOKEN}"
      to: a@example.com
      subject: s
      body: b
    - name: web
      action: http_request
      method: GET
      url: "https://x.example"
  workflow:
    - step: say
      type: tool
      tool: post
    - step: get
      type: tool
      tool: web
`;

describe("connector tiles", () => {
  const { spec, errors } = parseSpec(SPEC);
  const graph = specToGraph(spec!);

  it("parses the fixture", () => expect(errors).toEqual([]));

  it("uses the manifest's brand for a component, on its tool and on a step that calls it", () => {
    const known = brandsFromCatalog([
      { id: "kampong/slack", version: "1.0.0", brand: { label: "S", color: "#4A154B" } },
    ]);
    const tiles = connectorBrands(graph, known);
    expect(tiles["tool:post"]).toEqual({ label: "S", color: "#4A154B" });
    expect(tiles["workflow:say"]).toEqual({ label: "S", color: "#4A154B" });
  });

  it("falls back to the component's initial on the category colour", () => {
    const tiles = connectorBrands(graph, {});
    expect(tiles["tool:other"]).toEqual({ label: "W" });
    expect(tiles["tool:post"]).toEqual({ label: "S" });
  });

  it("has built-in tiles for Slack and Gmail, and none for a web request", () => {
    const tiles = connectorBrands(graph);
    expect(tiles["tool:mail"]?.label).toBe("G");
    expect(tiles["tool:web"]).toBeUndefined();
    expect(tiles["workflow:get"]).toBeUndefined();
    // The card still says what kind of step it is.
    expect(cardInfo(graph.nodes.find((n) => n.id === "workflow:say")!).kind).toBe("Tool step");
  });
});
