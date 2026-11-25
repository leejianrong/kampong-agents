import { describe, expect, it } from "vitest";
import { webhookLocation } from "../../src/routes/deployments.js";

describe("webhookLocation (KAM-321)", () => {
  it("returns only the path when the public origin is unknown", () => {
    expect(webhookLocation(undefined, "ws1", "dep1")).toEqual({ webhookPath: "/hooks/w/ws1/dep1" });
  });

  it("adds the full address when PUBLIC_BASE_URL is set", () => {
    expect(webhookLocation("https://kampong.abangai.dev", "ws1", "dep1")).toEqual({
      webhookPath: "/hooks/w/ws1/dep1",
      webhookUrl: "https://kampong.abangai.dev/hooks/w/ws1/dep1",
    });
  });
});
