# Setup Unification: One Convergence Program for Init, Onboarding, and Account Linking

**Status:** Active
**Date:** 2026-07-18
**Extends:** `agent-first-alpha-onboarding.md` (2026-03-19), `alpha-simplification-program.md`

## Problem

selftune currently has two partially overlapping initialization systems:

1. `selftune init` (`packages/runtime/init.ts`) — detects the agent, writes
   `~/.selftune/config.json`, installs Claude Code hooks, optionally runs
   device-code auth (`--alpha`), source sync, initial upload, and OS schedule
   install. Config writes go through a private `writeSelftuneConfig`, not the
   canonical `@selftune/config` writer.
2. Desktop onboarding (`packages/runtime/desktop-onboarding.ts` +
   `POST /api/v2/settings/onboarding`) — its own `installClaudeHooks`
   (packaged-snippet path or shelling out to `selftune init`), its own schedule
   toggling, and a separate `onboarding.json` "completed" flag.

Consequences: `config.json` and `onboarding.json` can disagree; hook-install
behavior forks between CLI and desktop; the cloud API key is stored inline in
`config.json` (0600 file) while Remote Library correctly uses the OS credential
store; and a cloud-linked user still has to separately configure Sync & Backup.

## Reference Pattern

The executor codebase (same product shape) avoids this class of bug by having
**one server own all behavior** — the desktop app hosts the same
`startServer()` the CLI's `web` command uses, sharing one state dir, and auth
is a service (`probe`/`start`/`complete`) that the onboarding UI merely calls.
State converges lazily; there is no "setup complete" flag that can drift.

selftune diverges in one deliberate way: `selftune init` must keep working
standalone with no daemon running, because agents run it in fresh environments
(agent-first constraint). So we unify on a **shared convergence program**, not
on mandatory daemon routing.

## Target Architecture

```
                      ┌──────────────────────────────────────────┐
CLI `selftune init` ──► packages/orchestration/src/setup/        │
                      │   inspect.ts   — read real state          │
Desktop wizard ───────►   plan.ts      — desired state (SetupPlan)│
 (via local daemon    │   converge.ts  — idempotent apply         │
  POST /settings/     │   link-account.ts — optional cloud link   │
  onboarding)         └───────┬──────────────────────────────────┘
                              │ capabilities (injected)
                 ┌────────────┼───────────────┐
                 HookInstallers  ScheduleManager  CredentialStore
                 (CLI in-proc /  (OS cron|launchd  (macOS/Win/Linux
                  desktop         / desktop         keychain, file
                  packaged)       supervisor jobs)  fallback)
```

### Principles

1. **Convergence, not scripts.** `convergeSetup(plan, capabilities)` reads
   current state, diffs against the plan, applies only what's missing, and
   returns per-step results (`satisfied | applied | failed | skipped`).
   Running it twice is a no-op. There is no stored "completed" boolean —
   setup status is always **derived** from real state.
2. **Adapters are thin.** CLI flags → `SetupPlan`; desktop wizard request →
   `SetupPlan`. Mechanism differences (packaged hook snippet vs in-process
   installer; desktop supervisor schedule vs OS cron/launchd) are injected
   capabilities, never forked workflows.
3. **Auth is an optional capability, not a gate.** Local observability, skill
   management, and improvement never require an account. `LinkCloudAccount`
   is a step the plan may include; it is the only step that talks to the
   cloud.
4. **One credential model.** All secrets go through
   `packages/runtime/credential-store.ts` (`platformCredentialStore`).
   `config.json` stores only `CredentialReference`s and identity metadata,
   never key material. (File-store fallback covers headless/CI hosts.)
5. **Cloud is seamless.** Once an account is linked, Sync & Backup / Remote
   Library derives its config from the linked identity (cloud URL + device
   credential) unless an explicit `remote-library.json` (self-hosted)
   overrides it. Linking once unlocks upload, backup, and private sharing
   with zero extra key-pasting.
6. **`packages/config` stays canonical.** All `config.json` reads/writes go
   through `@selftune/config` `loadConfig`/`writeConfig`. The private
   `writeSelftuneConfig` in `runtime/init.ts` is removed; any 0600/atomic
   semantics it carried move into the canonical writer.

### Data model changes (`packages/config/src/schema.ts`)

- `SelftuneFileConfig.preferences` (optional): the desired-state prefs that
  previously lived in `onboarding.json` — `import_sources`, `features`
  (`observability`, `health_recommendations`, `autonomous_improvement`).
  `hook_harnesses` is NOT persisted as preference; installed hooks are
  detected, not remembered.
- `AlphaIdentity.credential` (optional `CredentialReference`): replaces
  inline `api_key`. `api_key` remains in the schema as a legacy field; the
  accessor migrates it (store key → write reference → strip inline key) on
  first read.
- `onboarding.json` is demoted: on first converge/daemon start its prefs are
  migrated into `config.json.preferences` and the file is deleted.
  `OnboardingPreferences.completed` disappears; the desktop decides whether
  to show the wizard from derived status (`inspectSetupState()`), exposed by
  the existing settings/status route.

### Module layout

- `packages/orchestration/src/setup/` — `inspect.ts`, `plan.ts`,
  `converge.ts`, `capabilities.ts` (types + default CLI implementations),
  `link-account.ts`, `index.ts`. Effect-based, matching orchestration
  conventions; capabilities passed explicitly (plain interfaces) so the
  program stays testable without a live daemon.
- `packages/runtime/init.ts` shrinks to the CLI adapter: flag parsing,
  plan construction, converge invocation, and the **exact existing JSON
  output contract** (`device_code_issued`, `alpha_enrolled`, `sync_complete`,
  `autonomy_enabled`, `workspace_detected`, `doctor_result`, …). Agents parse
  these codes; they must not change in Phases 1–3.
- `packages/runtime/desktop-onboarding.ts` shrinks to: request →
  `SetupPlan` mapping + desktop capability wiring
  (`installPackagedClaudeHooks`, `updateDesktopSchedule`). All generic logic
  deleted.
- `packages/runtime/auth/` gains `resolveCloudCredential(config)` — the
  single accessor for the cloud API key (reference → store lookup, legacy
  inline-key migration). Every consumer (`registry/client.ts`,
  `alpha-upload/*`, `contributions/*`, upload cycle in init) switches to it.
- `packages/runtime/remote-library/config.ts` `loadRemoteLibraryConfig`
  gains a final fallback: if no env config and no `remote-library.json`, but
  the cloud account is linked, synthesize config from
  `alpha.cloud_api_url ?? DEFAULT_CLOUD_URL` + the alpha credential
  reference.

## Non-Goals

- No mandatory daemon routing for the CLI; no new CLI commands or flag
  changes (surface churn is deferred until after the unification lands).
- No dashboard wizard UI redesign; the wizard keeps calling
  `POST /api/v2/settings/onboarding` with the same body.
- No change to Remote Library self-hosted flows (explicit config always wins).
- No multi-machine credential sync.

## Phases

Each phase lands independently green (lint + targeted tests + sandbox
harness where touched).

1. **Shared convergence program + CLI on top** (behavior-preserving).
   New `orchestration/src/setup/`; `runtime/init.ts` refactored onto it;
   config writes via `@selftune/config`; existing `tests/init` +
   `tests/cli/command-surface-parity` stay green; new unit tests for
   inspect/converge idempotence.
2. **Desktop/daemon unification.** `applyOnboarding` operation delegates to
   the converge program with desktop capabilities; duplicate installers
   deleted; `onboarding.json` migrated into `config.json.preferences` and
   removed; desktop initial-path/status uses derived setup state.
3. **Credential unification + seamless cloud.** `LinkCloudAccount` program;
   keychain-backed alpha credential with legacy migration;
   `resolveCloudCredential` accessor sweep; remote-library cloud fallback.
4. **Docs propagation + closeout.** `skill/workflows/Initialize.md`,
   `ARCHITECTURE.md` module map, `docs/design-docs/agent-cli-contract.md`
   (only if outputs changed), move this plan to completed.

## Acceptance

- Running `selftune init` twice produces identical state and reports
  `satisfied` for every step the second time.
- Desktop wizard and `selftune init` produce the same hooks, schedules, and
  config for equivalent choices; no code path installs hooks outside the
  shared program.
- `config.json` contains no key material after any flow (fresh or migrated).
- With a linked account and no `remote-library.json`, `selftune library
status` / Sync & Backup work immediately using the device credential.
- `onboarding.json` no longer exists on upgraded installs; wizard visibility
  is derived.

## Progress

- Phase 1 implemented: shared setup inspection, planning, capabilities, and convergence with the
  CLI adapter layered on top.
- Phase 2 implemented: desktop onboarding delegates to convergence, preferences live in
  `config.json`, and legacy onboarding state migrates to derived status.
- Phase 3 implemented: account linking stores cloud credentials outside config, all cloud consumers
  resolve the shared credential, and linked accounts activate Sync & Backup automatically.
- Phase 4 implemented: agent-facing and architecture documentation propagated; closeout gates run.
