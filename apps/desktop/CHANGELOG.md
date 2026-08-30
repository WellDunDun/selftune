# @selftune/desktop

## 0.4.5

### Patch Changes

- [#166](https://github.com/selftune-dev/selftune/pull/166) [`36f051c`](https://github.com/selftune-dev/selftune/commit/36f051c22b1657ab89996b4803a114c107f82648) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Make the packaged macOS security smoke invoke its IPC probe only after the target document loads.

## 0.4.4

### Patch Changes

- [#164](https://github.com/selftune-dev/selftune/pull/164) [`039a208`](https://github.com/selftune-dev/selftune/commit/039a20836ca838664454e0dcb89806b646ed01b7) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Keep the packaged macOS release smoke focused on the isolated wrong-origin probe window.

## 0.4.3

### Patch Changes

- [#162](https://github.com/selftune-dev/selftune/pull/162) [`89a19ba`](https://github.com/selftune-dev/selftune/commit/89a19baf69685a628c6f664910c8372c2b61882f) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Restore the signed macOS packaged-smoke probe transport that is preserved through notarized application launches.

## 0.4.2

### Patch Changes

- [#160](https://github.com/selftune-dev/selftune/pull/160) [`b0c8f87`](https://github.com/selftune-dev/selftune/commit/b0c8f87b9efef6fe340ede9cc7cf121130e32245) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Restore the packaged runtime dependencies used by the self-host image and make the desktop release smoke test locate its security probe reliably.

## 0.4.1

### Patch Changes

- [#158](https://github.com/selftune-dev/selftune/pull/158) [`a204adb`](https://github.com/selftune-dev/selftune/commit/a204adbf6604490addd7442f51ef503a6da114bb) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Fix macOS release signing and self-host candidate validation so verified desktop and container artifacts can be promoted.

## 0.4.0

### Minor Changes

- [#157](https://github.com/selftune-dev/selftune/pull/157) [`259c3d1`](https://github.com/selftune-dev/selftune/commit/259c3d1e617fb9e516a1b180bf1b34aae1605e68) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Relaunch SelfTune as a local-first control center for agent skills: discover and reconcile libraries across supported harnesses, organize reusable Skill Sets, scope them to projects, review updates and evidence, and share portable packages through explicit local or optional remote boundaries.

### Patch Changes

- [#152](https://github.com/selftune-dev/selftune/pull/152) [`83d91de`](https://github.com/selftune-dev/selftune/commit/83d91de0ebb680b458396371a9094cb3b2011adf) Thanks [@ajlawrence](https://github.com/ajlawrence)! - Filter injected Codex context wrappers from ingested user queries and skill attribution.

- [#150](https://github.com/selftune-dev/selftune/pull/150) [`561eda0`](https://github.com/selftune-dev/selftune/commit/561eda093fc9c1fe58ee111121b554b0f3b8ba85) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Repair release SBOM generation when bundled workspace peer metadata cannot be resolved by npm's built-in generator.

## 0.3.3

### Patch Changes

- [#148](https://github.com/selftune-dev/selftune/pull/148) [`3c1dafa`](https://github.com/selftune-dev/selftune/commit/3c1dafa969316b3aca4a25b3f4a66534ddfb3583) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Allow the exact bundled native binaries changed by macOS code signing to pass
  the signed runtime integrity check while preserving strict source-copy verification.

## 0.3.2

### Patch Changes

- [#146](https://github.com/selftune-dev/selftune/pull/146) [`f527f71`](https://github.com/selftune-dev/selftune/commit/f527f7193a8a71a8901545e7a8f23525434c524f) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Use the PragSys Developer ID identity for signed macOS releases and include the
  DuckDB native runtime required by the compiled self-host image.

## 0.3.1

### Patch Changes

- [#143](https://github.com/selftune-dev/selftune/pull/143) [`b353bc5`](https://github.com/selftune-dev/selftune/commit/b353bc50ac580eda5a0c4efacba4d34cb0fad0ef) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Repair stable release artifact gates for current macOS signing identity selection, self-host credential and container proofs, and bounded Windows preload and pending-IPC readiness windows.

## 0.3.0

### Minor Changes

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Drive connection Settings and agent-assisted source merging from package-owned harness capabilities and client-safe presentation metadata.

### Patch Changes

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Discover hosted Skill Sets during Library sync and automatically download and verify missing pinned skill revisions before applying a set to a project. Keep fully local applies offline and stop remote, integrity, or destination-conflict failures before project mutation.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Add independently runnable Local, Cloud, Self-host, and packaged Desktop Library lifecycle validation with structured parity results, skips, screenshots, traces, logs, and recovery receipts.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Add restart-safe durable approvals for skill removal and conflicting Skill Set replacement, including fingerprint revalidation, expiry, audit history, quarantine or overwrite recovery receipts, and rollback.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Require durable, explicit, restart-safe approval before an agent-prepared source merge can update an installed skill.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Keep Insights decisions, drafts, evaluations, and releases consistent across the queue, Library, overview, proposal views, and live dashboard updates.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Keep Projects, Library, and overview synchronized after every Project Skill Set mutation and matching live event.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Restore evidence-backed Skill Set suggestions, human review feedback, and measured outcomes in the shared Local, Desktop, and Self-host dashboard. Rename the visible Projects surface to Skill Sets while preserving `/projects` as a compatibility route.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Restore the Skills Library's row actions, category controls, source and folder links, connection identity, revision context, archival recovery, and host-specific Cloud next actions in the shared dashboard.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Share licensed skills and Skill Sets through reusable copy links from SelfTune Cloud, Desktop, and local dashboards. This first release intentionally excludes email delivery, private single-claim links, and workspace-wide issuance.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Keep Library, portfolio, overview, source-update, and Project views consistent through one typed semantic reactivity registry shared by mutations and live dashboard events.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Render one adapter-driven Projects and Skill Sets experience across Local, Desktop, Self-host, and SelfTune Cloud, with shared creation, editing, searchable skill selection, installation review, apply, and rollback presentation.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Add protected This Mac, SelfTune Cloud, and custom Self-host server profiles to the shared dashboard, with explicit validation states, host-state isolation, and native-only Desktop credentials.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Render one adapter-driven Skills Library across Local, Desktop, Self-host, and SelfTune Cloud, with shared inventory, filters, details, diffs, and explicit action availability.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Classify installed skills locally and suggest reviewable Skill Sets from trusted ordered workflows, recurring co-usage, and project-specific session patterns in the CLI and desktop dashboard. Discover candidates from older sessions, validate recurrence against a chronological holdout, and expose exploratory, supported, or validated evidence instead of scoring a pattern on the same data that found it. Persist human category corrections, immutable suggestion evidence snapshots, and accepted, edited, or reasoned dismissal decisions in the local Drizzle store. Calibrate the evidence floor only after enough balanced human labels, measure accepted sets conservatively across completion, errors, trigger coverage, token use, and grading, and sync only redacted aggregate learned state while raw transcripts remain local.

- [#138](https://github.com/selftune-dev/selftune/pull/138) [`9f9bbad`](https://github.com/selftune-dev/selftune/commit/9f9bbadd085203de6ba801b731d61617ec436fcd) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Make stable release repair runs resume authenticated drafts through skipped release-PR ancestry, retry transient macOS packaging failures, and verify the actual Linux installer names before promotion.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Rename customer-facing Remote Library surfaces to Sync & Backup, distinguish SelfTune Cloud from self-hosted destinations, and keep the Remote Library name for the underlying protocol.

- [#141](https://github.com/selftune-dev/selftune/pull/141) [`1b0094b`](https://github.com/selftune-dev/selftune/commit/1b0094b228b298577d32a761738f645759a7d262) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Move the local operational database onto an Executor-style Drizzle schema and migration chain while preserving existing SQLite data and embedding migrations in the desktop runtime.

## 0.2.34

### Patch Changes

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Reorganize the local product into explicit CLI, daemon, runtime, orchestration, and per-harness packages while retaining the existing npm binary and hook entrypoints.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Route monorepo release intent through the coupled desktop release-train package, run each test suite with its native runner, and keep packaged smoke checks portable across Windows and Linux.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Prevent Skill Set rollback from deleting a replacement path when the filesystem reuses the original device and inode.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Harden the public release with host-aware runtime checks and linear-time parsing for remote URLs and invocation email signals.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Build public desktop and self-host releases with Bun 1.3.14, and cross-compile the Windows sidecar on Linux so the upstream Windows-host printer crash cannot block packaging.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Ship the CLI, desktop installers, and self-host image from one verified source commit, with candidate smoke tests completing before centralized release promotion.
