import { describe, expect, it } from "vitest";
import { createDevServer, PACKAGE_NAME } from "../../src/index.js";

describe("@kampong/cli scaffolding", () => {
  it("resolves the package entry point", () => {
    expect(PACKAGE_NAME).toBe("@kampong/cli");
  });

  it("wires up a Fastify server instance (ADR-0007)", async () => {
    const server = createDevServer();
    expect(server).toBeDefined();
    await server.close();
  });
});
