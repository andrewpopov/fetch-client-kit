# Shared Package Standards

This is a **TypeScript package**: source in `src/`, compiled with `tsc` to a
**committed** `dist/`. `main`/`types` point at `dist/`; the type gate is
`typecheck` + `build` + a dist-freshness check in CI. Zero runtime dependencies;
the browser `fetch` is the only ambient requirement.

Distribution and versioning: install from a git tag (`vX.Y.Z`); CI's
`release-guard` asserts each tag matches `package.json` and has a CHANGELOG
heading. Engineering standards that apply here:

1. **Superset of every consumer's copy.** This package must be at least as capable
   as each consumer's existing hand-rolled client before that consumer is
   migrated onto it.
2. **Expose the seam consumers need.** Auth attachment + refresh is the one thing
   that differed across the original consumers; it is the pluggable `AuthStrategy`.
3. **Types are a contract, tested.** `verify:pack` installs the tarball and
   resolves every export through both CJS and ESM.
4. **Uniform gates:** `test`, `verify:pack`, `typecheck` + `build` + dist freshness.
