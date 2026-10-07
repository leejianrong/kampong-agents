# ADR-0033: An export verifies its components, and leaves the records to do it

Date: 2026-10-07. Status: accepted. Card: KAN-1837. Builds on ADR-0010, ADR-0026, ADR-0031.

## Context

An export copies the exact bytes of every component it uses (KAN-1886) and bakes in each component's
digest, but nothing compared the two: the README said so. An exported project cannot be revoked
remotely and no longer has a `kampong.lock` reviewer in front of it, so the only party who can notice a
changed component is the project itself, and the person who holds it.

## Decision

- **Startup re-verification.** `src/components.generated.ts` re-hashes every file under `components/`
  with a vendored `runtime/component-verify.ts` and compares with the baked digests before the
  dispatcher exists. A mismatch throws a `ComponentVerificationError` naming each component and, from
  the baked per-file hashes, the files that were changed, added or missing. Nothing runs.
- **The digest is the registry's.** The check mirrors the engine's directory hash (sorted
  `path\0sha256(file)` lines; `node_modules` and `.DS_Store` skipped; symlinks and non-regular files
  refused), so an export verifies to the digest `kampong lock` pinned. It is hand-vendored, with no
  engine counterpart, and a unit test asserts the two agree.
- **Records.** An export that carries components also writes `kampong.lock` (the file `kampong lock`
  writes: digest and permissions per `id@version`) and `sbom.json` (CycloneDX 1.5: each component with
  its digest and kind, each file's SHA-256, and the module `deps` as `pkg:npm` entries). Both are
  deterministic: no timestamp, no serial number.
- **`npm run verify`** checks `components/` against `sbom.json`, a record independent of the digests
  baked into the code, so changing one of them is not enough to hide a change.

- **Nothing unhashed can supply code.** Digests skip `node_modules`, but a bare import inside a component
  resolves from a `node_modules` next to it first, and a `package.json` above it changes how `.js` loads.
  The exported check therefore fails on any `node_modules` inside a component and on any entry under
  `components/` that was not exported. The exporter refuses files at those paths.
- **`.gitattributes`** (`components/** -text`) keeps line-ending conversion on a clone from changing the
  hashed bytes.

## Not covered

- Signing and provenance of the export itself (the tarball or image), and Sigstore: KAN-1838.
- `node_modules`: dependencies are exact-pinned in `package.json` and installed by npm; verifying them is
  npm's lockfile integrity, not this check.
- Time of check to time of use. Components are verified once at startup, and a module is imported on
  its first call: a file changed while a server is up, before that call, is not noticed until the next
  start. Preloading the entries inside the check would narrow this. The owner of the machine is not the threat this addresses.
- Someone who can edit `src/` can remove the check. It protects against a swapped or altered component
  folder, not against an edited project.
