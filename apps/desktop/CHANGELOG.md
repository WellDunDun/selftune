# @selftune/desktop

## 0.2.34

### Patch Changes

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Reorganize the local product into explicit CLI, daemon, runtime, orchestration, and per-harness packages while retaining the existing npm binary and hook entrypoints.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Route monorepo release intent through the coupled desktop release-train package, run each test suite with its native runner, and keep packaged smoke checks portable across Windows and Linux.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Prevent Skill Set rollback from deleting a replacement path when the filesystem reuses the original device and inode.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Harden the public release with host-aware runtime checks and linear-time parsing for remote URLs and invocation email signals.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Build public desktop and self-host releases with Bun 1.3.14, and cross-compile the Windows sidecar on Linux so the upstream Windows-host printer crash cannot block packaging.

- [#135](https://github.com/selftune-dev/selftune/pull/135) [`c3fbe7d`](https://github.com/selftune-dev/selftune/commit/c3fbe7dcd938ce38c2799b55f5462c8ce7aa5fff) Thanks [@selftune-oss-export](https://github.com/apps/selftune-oss-export)! - Ship the CLI, desktop installers, and self-host image from one verified source commit, with candidate smoke tests completing before centralized release promotion.
