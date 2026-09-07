# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop

Version: 0.1.2

Revision: e8c4880471b23ab7f216fba7b27d173a6ef07d4c (2026-08-31)

The installed skill is tracked in `.agents/skills/install-anti-slop` and
`skills-lock.json`. Its bundled runtime is copied here; this directory is
canonical and is mirrored into the standalone OSS export by
`scripts/sync-embedded-shared.sh`.

Both root and standalone OSS use Oxlint and `@oxlint/plugins` pinned to 1.78.0.
All 15 generic rules and the opt-in Effect rule are enabled at error severity.
Root and nested configurations load the same embedded plugin modules to avoid
duplicate registration during recursive linting.

The module-mode `package.json` is repository integration metadata, not upstream
source. Before updating, compare changes, preserve local integration metadata,
run the enforcement tests, and verify embedded-package drift.

## Local policy corrections

The Effect import rule is syntax-only, so it enforces the explicit
`make*Service` naming contract instead of treating every `make*` factory as a
service constructor. Ordinary factories and conventional `Layer`/`Live` recipes
are outside that contract. The original imported name is checked, so aliasing a
`make*Service` constructor does not bypass enforcement. Package aliases and
namespace imports remain outside the rule's coverage.
No diagnostic from this syntax-only rule is semantic proof of an Effect service
lifecycle violation; the naming contract makes the enforced boundary explicit
and reviewable.

The runtime-boundary rules retain their default bans while allowing a reviewed,
local justification for invariants the syntax-only plugin cannot establish.
`SAFETY-TYPEOF: <reason>` applies only to its statement/check or containing
function. `SAFETY-UNKNOWN: <reason>` applies only to its runtime boundary
function's unknown parameters, explicit unknown return (including its return
flow), and local reflective dictionaries whose value type is exactly unknown.
It never permits `any`, and does not exempt nested functions, interfaces, or
module-level types.
The markers are distinct, require a nonempty reason, and do not grant a file-wide
exemption.

Preserve these corrections and their behavior tests when updating from upstream.
The installer asset remains the upstream vendor snapshot: never use an
unreviewed force install to overwrite this documented project-local delta.
