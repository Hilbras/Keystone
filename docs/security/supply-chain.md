# Supply chain

Covers SEC-011.

## What runs on every push and pull request

`.github/workflows/supply-chain.yml`:

| Job | Tool | Gate |
| --- | --- | --- |
| OSV vulnerability scan | osv-scanner | fails on any advisory |
| npm audit | npm | fails at `high` |
| Dependency review | GitHub action | fails on a new advisory in the diff |
| SBOM | CycloneDX | artefact, always produced |
| Container scan | Trivy | image, filesystem and secret scanning |
| License report | license-checker | fails on an unknown or disallowed licence |

`ci.yml` runs the same dependency and licence gates so a branch cannot be green
locally and red on the merge.

## The image finding that no scanner could see

The production Dockerfile installed npm so it could prune dev dependencies. That
npm carried **eight high-severity advisories** — and `npm audit` and the OSV
scanner both read the lockfile, not the image. Every configured gate was
satisfied while the shipped artefact was the vulnerable one.

npm is removed from the runtime stage. Pruning happens at build time in a stage
that is not part of the published image.

This is worth stating plainly because it is not a scanner gap that more
scanning would close: the tools were all present, all passing, and all reading a
different artefact from the one being shipped. Finding it required looking at what
was actually in the image.

## Release gate

`release.yml` refuses to publish unless every one of the following holds:

- a critical or high advisory exists with no documented exception
- the security suite passes
- typecheck, lint and build pass
- the dependency audit passes
- secret scanning passes
- the security registry validates
- the release metadata is consistent

Exceptions live in `docs/security/registry-exceptions.md` and must name the
advisory, the reason, and an expiry. An undocumented exception fails the gate.
