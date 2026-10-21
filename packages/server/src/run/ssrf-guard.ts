import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ToolCallError, type ToolFetchImpl } from "@kampong/engine";
import { Agent } from "undici";

// The hosted server's outbound guard for tool HTTP (KAM-232). A tenant's spec names the URLs its tools call, so
// without a guard it can aim the server at addresses only the server can reach: its own loopback, the cloud
// metadata service, the cluster's pod and service ranges, the database. This puts one rule in front of every tool
// and component call: the address a request would connect to must be a public one. The rule holds
//   - for a literal IP in the URL,
//   - for a name, after DNS resolution (every address it resolves to must be public),
//   - at connect time, so a name that answers public to the first lookup and private to the second (DNS
//     rebinding) is refused when the socket is opened, and
//   - at every redirect hop, since a public URL can send the request to a private one.
// A request that fails the rule never leaves the process. Local mode does not use this: a developer's own tools
// legitimately call localhost. `allowHosts` is the self-host exception, for internal services an operator chooses.

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, also used for node-local ranges
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** The IPv4 address an IPv6 one wraps (mapped, NAT64 or 6to4), or null when it wraps none. */
function embeddedV4(address: string): string | null {
  const groups = expandV6(address);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return v4(g6, g7);
  }
  // 64:ff9b::/96 (NAT64 well-known prefix)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4(g6, g7);
  }
  // 2002::/16 (6to4): the IPv4 address follows the prefix
  if (g0 === 0x2002) return v4(g1, g2);
  return null;
}

function expandV6(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  // A trailing dotted quad (::ffff:1.2.3.4) is two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text =
      text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const numbers = all.map((g) => Number.parseInt(g, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? numbers
    : null;
}

/** Whether a request to this address would reach something that is not on the public internet. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, "ipv4");
  if (family === 6) {
    if (BLOCKED.check(bare, "ipv6")) return true;
    const wrapped = embeddedV4(bare);
    return wrapped !== null && BLOCKED.check(wrapped, "ipv4");
  }
  // Not an address at all: nothing to let through.
  return true;
}

export interface GuardedFetchOptions {
  /**
   * Hostnames or IP addresses that may be reached even though they are private: the self-host exception, for
   * internal services an operator names. Exact match on the host, no wildcards. Empty by default.
   */
  allowHosts?: readonly string[];
  /** Resolves a name to every address it has. Default: the system resolver. A test seam. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** What actually sends the request. Default: the global `fetch`. A test seam. */
  base?: (url: string, init: RequestInit) => Promise<Response>;
  /** Redirects followed by hand before giving up. Default 5. */
  maxRedirects?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const systemResolve = async (hostname: string) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** The `ALLOW` list from an environment value: comma-separated hosts, trimmed, lower-cased, blanks dropped. */
export function parseAllowHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

/**
 * A tool `fetchImpl` that refuses to connect to a private address. It follows redirects itself (checking each
 * hop) unless the caller asked for `redirect: "manual"`, which the engine does for a request that carries a
 * credential, and then it only checks the one URL it was given.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): ToolFetchImpl {
  const allow = new Set((options.allowHosts ?? []).map((h) => h.toLowerCase()));
  const resolve = options.resolve ?? systemResolve;
  const maxRedirects = options.maxRedirects ?? 5;

  const allowed = (hostname: string) => allow.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));

  async function addressesOf(hostname: string): Promise<string[]> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    return isIP(bare) !== 0 ? [bare] : resolve(bare);
  }

  function refuse(toolName: string | undefined, url: URL, why: string): never {
    throw new ToolCallError(
      `${toolName ? `Tool "${toolName}": ` : ""}outbound call to ${url.origin} was blocked: ${why}. ` +
        `Hosted tools may only reach public internet addresses.`,
      "permission",
      false,
    );
  }

  async function check(url: URL, toolName: string | undefined): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      refuse(toolName, url, `${url.protocol.replace(":", "")} is not an allowed scheme`);
    }
    if (allowed(url.hostname)) return;
    let addresses: string[];
    try {
      addresses = await addressesOf(url.hostname);
    } catch (err) {
      // An unresolvable name is not a private one: let the request fail the way it normally would.
      if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") return;
      throw err;
    }
    const bad = addresses.find(isBlockedAddress);
    if (bad !== undefined) {
      refuse(toolName, url, `${url.hostname} is, or resolves to, a private address (${bad})`);
    }
  }

  // The same rule again at connect time, on the address the socket is about to use. The first check above gives a
  // clear error; this one is what stops a name whose answer changes between the check and the connect.
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, lookupOptions, callback) => {
        const hostnameAllowed = allowed(hostname);
        void addressesOf(hostname).then(
          (addresses) => {
            const bad = hostnameAllowed ? undefined : addresses.find(isBlockedAddress);
            if (bad !== undefined) {
              callback(
                new Error(`blocked: ${hostname} resolves to a private address (${bad})`),
                "",
                0,
              );
              return;
            }
            const entries = addresses.map((address) => ({
              address,
              family: isIP(address),
            }));
            if (lookupOptions.all) callback(null, entries);
            else callback(null, entries[0]!.address, entries[0]!.family);
          },
          (err: Error) => callback(err, "", 0),
        );
      },
    },
  });

  const send =
    options.base ??
    ((url: string, init: RequestInit) =>
      fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: unknown }));

  return async (input, init, context) => {
    let url = new URL(String(input instanceof Request ? input.url : input));
    let method = init?.method ?? (input instanceof Request ? input.method : "GET");
    // The body is tracked apart from the rest of `init`, so a redirect that turns the request into a GET can drop it.
    let { body, ...rest } = init ?? {};
    const toolName = context?.toolName;
    const followHere = rest.redirect !== "manual";

    for (let hops = 0; ; hops += 1) {
      await check(url, toolName);
      const response = await send(url.toString(), {
        ...rest,
        method,
        ...(body !== undefined && body !== null ? { body } : {}),
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (!followHere || !REDIRECTS.has(response.status) || location === null) return response;
      if (hops >= maxRedirects) {
        void response.body?.cancel();
        throw new ToolCallError(
          `${toolName ? `Tool "${toolName}": ` : ""}outbound call to ${url.origin} followed too many redirects`,
          "http",
          false,
          response.status,
        );
      }
      void response.body?.cancel();
      const next = new URL(location, url);
      // The browser rules: 303, and 301/302 after a POST, become a GET with no body.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      // Credentials do not travel to another origin.
      if (next.origin !== url.origin && rest.headers) {
        const kept = new Headers(rest.headers);
        kept.delete("authorization");
        kept.delete("cookie");
        rest = { ...rest, headers: kept };
      }
      url = next;
    }
  };
}
