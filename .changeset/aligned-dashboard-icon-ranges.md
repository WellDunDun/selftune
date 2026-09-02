---
"@selftune/desktop": patch
---

Repair release verification so the npm candidate's SBOM can be generated again. The bundled dashboard packages now agree on one `lucide-react` range, the shared UI package pins `@pierre/diffs` and `@pierre/trees` to the versions it is tested with, and the release workflow generates and validates the SBOM with a locked CycloneDX toolchain before publishing to npm, so a failed candidate can no longer leave npm ahead of the GitHub release.
