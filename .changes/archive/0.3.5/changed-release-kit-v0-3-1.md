---
kind: changed
summary: Release tooling upgraded to release-kit v0.3.1, so a feature release is graded as a minor rather than a patch
---

This package's release-kit was pinned at v0.2.0, whose `stableSemver` incremented the patch component regardless of fragment kind — measured directly, a `minor` and even a `major` bump both resolved to a patch, and `bumpLevelSupport` was absent. Any release adding public surface would therefore have been published as a patch, telling every consumer the upgrade added nothing. That was not hypothetical: during the PKG-114 cuts, alert-kit on v0.2.0 derived 0.5.1 for a release that added a whole new public module, caught only because the derived version was read before cutting.

No runtime change — release-kit is a devDependency and nothing this package exports is affected.
