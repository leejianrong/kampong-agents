# Security policy

## Reporting a vulnerability

Please report a vulnerability **privately**, not in a public issue or pull request:

1. Open a [private security advisory](https://github.com/leejianrong/kampong-agents/security/advisories/new)
   on this repository.
2. Say what you found, the version or commit, and how to reproduce it. A failing test or a short script
   is the fastest way for us to confirm it.

We aim to acknowledge a report within three working days and to tell you what we plan to do within ten.
We will credit you in the advisory unless you ask us not to. Please give us reasonable time to fix the
problem before you disclose it.

A machine-readable version of this is in [`.well-known/security.txt`](.well-known/security.txt)
(RFC 9116). It has an expiry date; if it has lapsed, the policy above still stands.

## What is in scope

Anything that lets a component, a spec, a webhook caller or a web page do more than it was allowed to:
reading a secret it has not been given, sending one to a host it is not bound to, running unreviewed
code, skipping the digest pin or the permission review, or bypassing a revocation. See
[ADR-0026](docs/adr/0026-component-trust-tiers-vetting-and-mcp.md),
[ADR-0031](docs/adr/0031-component-permissions-what-is-enforced.md) and
[ADR-0037](docs/adr/0037-revocation-and-release-signing.md) for what is and is not enforced. In
particular, a `kind: module` component runs in-process with no sandbox yet, so only reviewed modules
should be installed; that is documented behaviour, not a vulnerability by itself.

## Revoked components

A component version that turns out to be malicious or vulnerable is listed as revoked in the registry
index that ships with each release (`packages/engine/components/registry-index.json`). A run, a pin and an
export all refuse a revoked component and say why. You can add your own revocations to
`.kampong/registry-index.json` in a project; that file can only revoke, never vouch.

An exported project cannot be revoked remotely. Its `kampong.lock`, `sbom.json` and the startup check
(ADR-0033) are how you verify what you hold; watch the advisories for components you export.

## Verifying a release

Release artifacts are built in CI and signed keylessly: a build provenance attestation (Sigstore, tied to
the workflow run through GitHub's OIDC identity) is published for each artifact. To check one you
downloaded:

```
gh attestation verify kampong-<version>.tgz --repo leejianrong/kampong-agents
```

The release also carries an SBOM (`sbom.cdx.json`), the registry index, and `SHA256SUMS`.
