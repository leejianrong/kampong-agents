# ADR-0058: Hosted tool HTTP may only reach public addresses

- Status: Proposed (KAM-232). The guard itself is a security default; the operator allow-list in "Decision" is the one new surface and needs the product owner's sign-off.
- Date: 2026-10-22
- Deciders: Jian (product owner)

## Context

A spec names the URLs its tools call. Locally that is the developer's own business, and calling `localhost` is a
feature. On the hosted server the spec is a tenant's, and the server's network position is not the tenant's:
from the server process, `http://169.254.169.254/` is the cloud metadata service, `http://10.x.x.x/` is the
cluster, `http://127.0.0.1:5432/` is its own database. Nothing stopped a tenant tool from calling them. Hosted
runs already get an empty environment (ADR-0056), so the server's secrets are not in the tenant's reach by
name; the network was the remaining way in. It predates spec 1.1 and has to be closed before public signup.

## Options

1. **Block by URL text** (reject `localhost`, `127.`, `10.` in the string). Rejected: a name can resolve to a
   private address, `0x7f.1` and `2130706433` are loopback, and IPv6 can wrap an IPv4 address.
2. **Resolve the name, check the addresses, then fetch.** Closer, but the fetch resolves again, so a name that
   answers public to the check and private to the connect (DNS rebinding) gets through. A redirect from a public
   URL to a private one also gets through.
3. **Check the address a connection will use, at connect time, and again at every redirect hop.** Chosen.
4. **An egress proxy or network policy only.** A good second layer for a deployment, but it is not in the
   product: a self-hosted install without it would be open. The guard is in the process; a network policy can sit
   beside it.

## Decision

- `createGuardedFetch` (`packages/server/src/run/ssrf-guard.ts`) is the default `fetchImpl` of the hosted run
  manager, so every tool and component call goes through it. Local mode is untouched.
- An address is blocked when it is loopback, private (RFC 1918), carrier-grade NAT, link-local (including the
  metadata address), unspecified, multicast, reserved, documentation, unique-local or site-local IPv6, or an IPv6
  address that wraps one of those IPv4 ranges (mapped, NAT64, 6to4). Anything that is not an address is blocked.
- The check runs on a literal IP in the URL, on every address a name resolves to (one private answer among
  public ones blocks it), and again in the connection's own DNS lookup (undici `connect.lookup`), which is what
  stops rebinding. A scheme other than `http` and `https` is refused.
- Redirects are followed by the guard, one hop at a time, each checked before any connection to it (the browser
  rules for 303 and POST, `Authorization` and `Cookie` dropped across origins, at most 5 hops). A caller that asks
  for `redirect: "manual"`, as the engine does for a request carrying a credential, gets the response back and
  its next call is checked the same way.
- A block is a `ToolCallError` with code `permission` that is not retryable, naming the tool and the host.
- **Self-host exception:** `KAMPONG_EGRESS_ALLOW_HOSTS` (comma-separated exact hostnames or IP addresses), or
  `egressAllowHosts` in code, lets an operator name internal services a tool may reach. Empty by default, no
  wildcards and no ranges, so each exception is a deliberate, visible line.
- Replacing `fetchImpl` is a test seam; a replacement is not guarded.

## Consequences

- Not covered: the model provider call. A hosted tenant's model `base_url` is a separate path (BYOK client in
  `model/resolve.ts`) and wants the same guard (KAM-234).
- Slack's `response_url` in an approval reply comes from a signed Slack request and is not a tenant's URL.
- The guard adds one DNS lookup per call. Answers are not cached here; the system resolver's cache does that.
- `undici` becomes a direct dependency of `packages/server`. It was already in the tree (the same major as Node 24's
  built-in fetch).
