# Shared Package Standards

> **Canonical source:** `agent_brain/knowledge/shared-package-standards.md`.
> This file is a synced copy; change the canonical doc first.

This is a **TypeScript package**: source in `src/`, compiled with `tsc` to a
**committed** `dist/`. `main`/`types` point at `dist/`; the type gate is
`typecheck` + `build` + a dist-freshness check in CI. Zero runtime dependencies;
the browser `fetch` is the only ambient requirement.

Distribution, versioning, branch protection, CI, and the release checklist follow
the canonical standard. Engineering standards that apply here:

1. **Superset of every consumer's copy.** This package must be at least as capable
   as smarthome's `api-client-kit`, savoro's and towerpower's hand-rolled clients,
   before any of them is migrated onto it.
2. **Expose the seam consumers need.** Auth attachment + refresh is the one thing
   that differed across the three; it is the pluggable `AuthStrategy`.
3. **Types are a contract, tested.** `verify:pack` installs the tarball and
   resolves every export through both CJS and ESM.
4. **Uniform gates:** `test`, `verify:pack`, `typecheck` + `build` + dist freshness.
