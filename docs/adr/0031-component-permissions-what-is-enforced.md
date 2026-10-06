# ADR-0031: Component permissions: what is enforced, and what is not

- Status: Accepted
- Date: 2026-10-07
- Deciders: Jian (product owner)

## Context

ADR-0026 says every component carries a permission manifest, enforced on first-party components too: an
egress allow-list, secret slots bound to hosts, and declared filesystem, env and exec permissions. KAN-1835
built the rest of that. The egress list and the slot hosts were already enforced by the op-call pipeline
(KAN-1832). The open question was how much of "fs, env and exec" can honestly be enforced while a module
runs in the engine's own process.

## Decision

1. **Enforced on every call, for every component, first-party included:** a request to a host outside
   `permissions.egress` is refused before any network call; a secret is sent only to the hosts its slot
   is bound to; secrets come only from declared slots; a module's `ctx.fetch` refuses an undeclared host,
   and after reading a secret refuses any host that secret is not bound to.
2. **Enforced by what a module is handed:** a module receives `ctx`, not `process.env`. `ctx.env.get(name)`
   returns only the variables named in `permissions.env`; any other name is a `permission` error. A secret's
   own variable cannot be named there (the manifest is refused), so it can only be read through its slot.
3. **Checked statically, not enforced at run time:** `scanModuleSources` (in `@kampong/spec`) reads every
   JavaScript file of a module and refuses `process`, `globalThis`/`global`, `eval`, `new Function`,
   `.constructor(`, `require`, the global `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`, a dynamic
   import that is not a string literal, an import that leaves the component's directory or names a URL,
   and any import of a built-in or package the manifest does not allow: network built-ins always
   (use `ctx.fetch`), `fs` without `permissions.fs`, `child_process`/`vm`/`worker_threads` without
   `permissions.exec`, an npm package not in `deps`. It runs when a component is resolved (so before any of
   it is imported), when a listing is built, when an author pins it, and when an export is made.
4. **This is not a sandbox and does not claim to be.** A module is code running in the engine's process.
   The static check catches mistakes and unsophisticated misbehaviour in reviewed code; code written to
   evade it can. What the manifest declares for `fs` and `exec` is therefore a statement a reviewer can
   hold the code to, not a wall. The wall is a `ModuleRunner` that is not in-process.
5. **The Runner interface says how much isolation it gives.** `ModuleRunner.isolation` is `none` or
   `sandbox` (absent means `none`); the in-process runner is `none`. `invokeOp` takes
   `requireIsolation: "sandbox"` and then refuses a module op on a weaker runner, before running anything.
   A host that runs components with someone else's secrets, such as the hosted server, sets it, so modules
   do not run there until a sandboxed runner exists. A rest component runs no code and is unaffected.
6. **A wider grant needs explicit re-approval.** `kampong.lock` records what each component could do when
   it was pinned. `kampong lock` prints that for a new pin. `kampong lock --update` that would widen it
   (a new host, env name, fs mode, exec, or a secret reaching a new host) is refused, with the list of
   what widened, unless `--allow-wider-permissions` is also given. A narrower grant or a code-only change
   updates normally. A pin made before permissions were recorded has nothing to compare against, so its
   first update only records.
7. **A rest component runs no code**, so it cannot declare `env`, `fs` or `exec`; a module may omit
   `egress` if it makes no request.

## Consequences

- The sandbox choice (isolates, Deno permissions, a container) stays open, as ADR-0026 section 5 says. When
  one exists it implements `ModuleRunner` with `isolation: "sandbox"` and the hosted server turns on
  `requireIsolation`; component code does not change.
- Because the scan runs at resolution, a module that violates its manifest shows up as a problem in the
  canvas component list and cannot be pinned, run or exported.
- A first-party module is held to the same checks as any other: `kampong/gmail` passes them unchanged.
- Not covered here: vetting of `deps` (KAN-1838), startup re-verification of an export's files (KAN-1837),
  and the permission diff in `kampong doctor` (KAN-1836).
