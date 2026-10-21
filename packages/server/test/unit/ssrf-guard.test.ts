import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolCallError } from "@kampong/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../src/db/client.js";
import { HostedRunManager } from "../../src/run/manager.js";
import { createGuardedFetch, isBlockedAddress, parseAllowHosts } from "../../src/run/ssrf-guard.js";

// KAM-232: hosted tool HTTP may only reach public addresses: for a literal IP, for a name after DNS, at connect
// time (DNS rebinding) and at every redirect hop. Local mode is not guarded; the hosted run manager is.

const CTX = { toolName: "lookup" };

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254", // the cloud metadata service
    "169.254.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1", // an IPv4 address wrapped in IPv6, three spellings
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "not-an-address",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "192.167.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "2002:808:808::1",
  ])("lets %s through", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("parseAllowHosts", () => {
  it("reads a comma-separated list, trimmed and lower-cased", () => {
    expect(parseAllowHosts(" Internal.Svc , 10.0.0.5,, ")).toEqual(["internal.svc", "10.0.0.5"]);
    expect(parseAllowHosts(undefined)).toEqual([]);
  });
});

const ok = () => new Response("{}", { status: 200 });
const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

describe("createGuardedFetch", () => {
  it("refuses a literal private address without sending anything", async () => {
    const base = vi.fn(async () => ok());
    const guarded = createGuardedFetch({ base });
    for (const url of [
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/",
      "http://10.1.2.3/",
      "http://0x7f.1/", // WHATWG URL parses this to 127.0.0.1
      "http://2130706433/", // and this
    ]) {
      const error = await guarded(url, undefined, CTX).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).code).toBe("permission");
      expect((error as ToolCallError).retryable).toBe(false);
      expect((error as Error).message).toContain('Tool "lookup"');
    }
    expect(base).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address, even among public ones", async () => {
    const base = vi.fn(async () => ok());
    const resolve = vi.fn(async (host: string) =>
      host === "mixed.test" ? ["93.184.216.34", "10.0.0.7"] : ["10.0.0.8"],
    );
    const guarded = createGuardedFetch({ base, resolve });
    await expect(guarded("http://mixed.test/", undefined, CTX)).rejects.toThrow(
      /private address \(10\.0\.0\.7\)/,
    );
    await expect(guarded("https://internal.test/", undefined, CTX)).rejects.toThrow(
      /private address/,
    );
    expect(base).not.toHaveBeenCalled();
  });

  it("refuses a scheme that is not http or https", async () => {
    const base = vi.fn(async () => ok());
    const guarded = createGuardedFetch({ base });
    await expect(guarded("file:///etc/passwd", undefined, CTX)).rejects.toThrow(
      /not an allowed scheme/,
    );
    await expect(guarded("ftp://example.com/", undefined, CTX)).rejects.toThrow(
      /not an allowed scheme/,
    );
    expect(base).not.toHaveBeenCalled();
  });

  it("sends a public request, with redirects handled by the guard", async () => {
    const base = vi.fn(async () => ok());
    const guarded = createGuardedFetch({ base, resolve: async () => ["93.184.216.34"] });
    const response = await guarded("https://api.example.com/q", { method: "GET" }, CTX);
    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledWith(
      "https://api.example.com/q",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("does not follow a redirect to a private address", async () => {
    const base = vi.fn(async () => redirect("http://169.254.169.254/latest/meta-data/"));
    const guarded = createGuardedFetch({ base, resolve: async () => ["93.184.216.34"] });
    await expect(guarded("https://api.example.com/q", undefined, CTX)).rejects.toThrow(/blocked/);
    // The second hop was refused before any connection to it.
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to a name that resolves privately", async () => {
    const base = vi.fn(async () => redirect("http://internal.test/"));
    const resolve = async (host: string) =>
      host === "internal.test" ? ["10.0.0.9"] : ["93.184.216.34"];
    const guarded = createGuardedFetch({ base, resolve });
    await expect(guarded("https://api.example.com/q", undefined, CTX)).rejects.toThrow(
      /private address/,
    );
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("follows redirects between public hosts the way fetch does: 303 becomes a GET, credentials stay home", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const base = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? redirect("https://other.example.org/done", 303) : ok();
    });
    const guarded = createGuardedFetch({ base, resolve: async () => ["93.184.216.34"] });
    await guarded(
      "https://api.example.com/q",
      { method: "POST", body: "x=1", headers: { authorization: "Bearer t", "x-trace": "1" } },
      CTX,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://other.example.org/done");
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.init.body).toBeUndefined();
    const headers = new Headers(calls[1]!.init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-trace")).toBe("1");
  });

  it("hands a redirect back unfollowed when the caller asked for manual, and checks the next call", async () => {
    const base = vi.fn(async () => redirect("http://10.0.0.1/"));
    const guarded = createGuardedFetch({ base, resolve: async () => ["93.184.216.34"] });
    const response = await guarded("https://api.example.com/q", { redirect: "manual" }, CTX);
    expect(response.status).toBe(302);
    expect(base).toHaveBeenCalledTimes(1);
    // The engine follows by hand and calls again: that call is refused.
    await expect(guarded("http://10.0.0.1/", { redirect: "manual" }, CTX)).rejects.toThrow(
      /blocked/,
    );
  });

  it("gives up after too many redirects", async () => {
    const base = vi.fn(async () => redirect("https://api.example.com/again"));
    const guarded = createGuardedFetch({
      base,
      resolve: async () => ["93.184.216.34"],
      maxRedirects: 3,
    });
    await expect(guarded("https://api.example.com/q", undefined, CTX)).rejects.toThrow(
      /too many redirects/,
    );
    expect(base).toHaveBeenCalledTimes(4);
  });

  it("lets an operator name an internal host, by exact name or address, and nothing else", async () => {
    const base = vi.fn(async () => ok());
    const guarded = createGuardedFetch({
      base,
      resolve: async () => ["10.0.0.5"],
      allowHosts: ["billing.internal", "10.0.0.9"],
    });
    await expect(guarded("http://billing.internal/x", undefined, CTX)).resolves.toBeTruthy();
    await expect(guarded("http://10.0.0.9/x", undefined, CTX)).resolves.toBeTruthy();
    await expect(guarded("http://other.internal/x", undefined, CTX)).rejects.toThrow(/private/);
    await expect(guarded("http://10.0.0.10/x", undefined, CTX)).rejects.toThrow(/private/);
  });

  it("lets a name that does not exist fail the way it normally would, not as a block", async () => {
    const base = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const resolve = async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    const guarded = createGuardedFetch({ base, resolve });
    await expect(guarded("http://nope.invalid/", undefined, CTX)).rejects.toThrow("fetch failed");
  });
});

// Real sockets: the guard's own dispatcher, with only the resolver faked.
describe("createGuardedFetch over real connections", () => {
  let server: Server | undefined;
  const hits: string[] = [];

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    hits.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("does not connect to loopback, by address or by the name localhost", async () => {
    const port = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.end("{}");
    });
    const guarded = createGuardedFetch();
    await expect(guarded(`http://127.0.0.1:${port}/a`, undefined, CTX)).rejects.toThrow(/blocked/);
    await expect(guarded(`http://localhost:${port}/b`, undefined, CTX)).rejects.toThrow(/blocked/);
    expect(hits).toEqual([]);
  });

  it("reaches loopback only when the operator allows it", async () => {
    const port = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.end('{"ok":true}');
    });
    const guarded = createGuardedFetch({ allowHosts: ["127.0.0.1"] });
    const response = await guarded(`http://127.0.0.1:${port}/a`, undefined, CTX);
    expect(await response.json()).toEqual({ ok: true });
    expect(hits).toEqual(["/a"]);
  });

  it("refuses a redirect from an allowed host to the metadata address before connecting to it", async () => {
    const port = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const guarded = createGuardedFetch({ allowHosts: ["127.0.0.1"] });
    await expect(guarded(`http://127.0.0.1:${port}/go`, undefined, CTX)).rejects.toThrow(/blocked/);
    expect(hits).toEqual(["/go"]);
  });

  it("stops DNS rebinding: a name that is public to the check and private to the connect is refused at connect", async () => {
    const port = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.end("{}");
    });
    let asked = 0;
    // The first answer (the pre-check) is public; every later one (the connection's own lookup) is loopback.
    const guarded = createGuardedFetch({
      resolve: async () => (asked++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });
    await expect(guarded(`http://rebind.test:${port}/x`, undefined, CTX)).rejects.toThrow();
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(hits).toEqual([]);
  });
});

describe("HostedRunManager", () => {
  it("guards tool HTTP by default and uses a supplied fetchImpl as is (a test seam)", async () => {
    const guardedManager = new HostedRunManager({} as DbClient);
    const fetchOf = (m: HostedRunManager) =>
      (m as unknown as { toolFetch: ReturnType<typeof createGuardedFetch> }).toolFetch;
    await expect(fetchOf(guardedManager)("http://127.0.0.1:1/", undefined, CTX)).rejects.toThrow(
      /blocked/,
    );

    const supplied = vi.fn(async () => ok());
    const custom = new HostedRunManager({} as DbClient, { fetchImpl: supplied });
    await fetchOf(custom)("http://127.0.0.1:1/", undefined, CTX);
    expect(supplied).toHaveBeenCalled();

    const allowing = new HostedRunManager({} as DbClient, { egressAllowHosts: ["127.0.0.1"] });
    // Allowed, so the guard lets it go to the (closed) port and the connection itself fails.
    await expect(fetchOf(allowing)("http://127.0.0.1:1/", undefined, CTX)).rejects.not.toThrow(
      /blocked/,
    );
  });
});
