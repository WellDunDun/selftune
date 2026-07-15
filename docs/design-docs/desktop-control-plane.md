<!-- Verified: 2026-07-15 -->

# Desktop Control Plane

SelfTune Desktop packages the existing local dashboard as a native Electron app. It follows the
same runtime ownership pattern used by Executor: Electron owns window security, while the same
compiled `selftune` CLI executable owns daemon startup, the local API, SQLite access, skill
discovery, and OS-service registration. Installed builds hand that executable to launchd,
systemd, or Task Scheduler, so observability and scheduled work do not depend on the dashboard
window or Electron process.

## Runtime

```text
Electron main
  -> loads or creates ~/.selftune/server-control/auth.json (0600)
  -> calls `selftune service status --json`
  -> derives "background enabled" only from actual OS-service registration
  -> attaches to a reachable OS-supervised daemon when registered
  -> upgrades that service only when its valid SemVer is older than the desktop
  -> otherwise attaches to an existing CLI runtime or starts a desktop-managed child
  -> exposes that same packaged CLI path to background scheduling and hooks
  -> waits for SELFTUNE_READY:<port>
  -> reads the owner-written ~/.selftune/server-control/server.json (0600)
  -> injects Authorization: Bearer <token> in a dedicated Electron session
  -> opens the sidecar URL in BrowserWindow
```

The CLI, browser dashboard, and desktop share `~/.selftune` and the same SQLite database. Electron
does not introduce a second application database or duplicate business logic.

Runtime ownership and supervision are separate fields in the version 2 `server.json` manifest:

| Launcher                  | `owner`   | `supervision`   | Lifecycle authority                 |
| ------------------------- | --------- | --------------- | ----------------------------------- |
| Electron child            | `desktop` | `desktop-child` | Electron process                    |
| Desktop-installed service | `desktop` | `os-service`    | launchd, systemd, or Task Scheduler |
| CLI-installed service     | `cli`     | `os-service`    | launchd, systemd, or Task Scheduler |
| Direct CLI daemon         | `cli`     | `none`          | CLI caller                          |

Legacy manifests remain readable. A legacy supervised manifest is treated conservatively as
CLI-owned. The desktop never uses a healthy child or direct CLI daemon as evidence that the
background service is enabled. It also never replaces a service whose version is unknown, equal,
or newer. In particular, an older desktop attaches to a newer CLI-owned service instead of
downgrading it. `selftune service install` intentionally takes over an authenticated predecessor
using the same config directory before registering and starting the supervisor, preserving the
single-runtime lock.

On first installed launch, SelfTune asks whether to keep the local service running. Enabling it
calls `selftune service install`; the CLI writes the platform definition with login startup and
crash recovery. The bearer token is never written to the supervisor definition; the daemon reads
the owner-only auth record directly. A clean disable calls `selftune service uninstall`. If the
registered service cannot be reached, Electron preserves its installed owner and may attach to
another authenticated local runtime so the UI can still open.

Electron probes health every five seconds. Three consecutive misses trigger bounded recovery by
restarting the registered service without rewriting its definition. Recovery never reinstalls an
unknown or newer service. Startup and renderer failures keep a recovery window open with restart,
update check, redacted diagnostics export, and reset actions. Reset first backs up the local SQLite
runtime and server-control state; it does not delete skills, settings, logs, or Remote Library
credentials. A reset restarts the same registered service definition, preserving its CLI or desktop
owner. App shutdown cancels an in-flight child startup, awaits the current ownership transition,
and stops only desktop-child candidates that became visible during that transition.

The Electron main process composes one managed Effect runtime. Its scoped `DesktopRuntime` service
owns the active connection generation, pending desktop children, background registration state,
the health-monitor fiber, and one semaphore that queues every ownership mutation. Health probes
and child-exit notifications carry the generation they observed, so results from a replaced
connection are ignored. Concurrent restart, background-toggle, reset, recovery, and update
preparation requests wait for the current transition instead of being dropped.

Window, tray/updater, and IPC resources have independent owners. Window replacement loads the next
authenticated origin before committing it and retains the working window if loading fails. Sidecar
responses used by the native tray are decoded through Effect Schema. IPC handlers validate unknown
renderer input and are removed during shutdown; authenticated session hooks, updater listeners,
tray timers, monitor fibers, and desktop children are all disposed through their owning controller
or managed scope. Internal workspace modules are compiled into the Electron main bundle rather than
shipping TypeScript entrypoints under `node_modules`. `src/main/index.ts` contains only Electron
boot, composition, and finalization.

Systemd installation records when SelfTune enabled user lingering; uninstall disables lingering
only when that marker proves SelfTune owns the change. A launchd definition emits
`AssociatedBundleIdentifiers` only when the executable is inside a real app bundle with a readable
bundle identifier. On Windows, stop and uninstall capture the authenticated OS-service instance
before ending the scheduled task and may terminate only that same PID and instance ID. A successor
foreground CLI runtime is never treated as task-owned cleanup. Service readiness requires a
reachable `os-service` manifest and, where the supervisor reports one, the same PID.

Packaged desktop automation can set `SELFTUNE_TEST_SKIP_BACKGROUND_SERVICE=1` to choose the
first-run "Not Now" branch without opening the native dialog.
`SELFTUNE_DESKTOP_USER_DATA_DIR` accepts an absolute directory for isolated Electron state and is
applied before diagnostics and app readiness. These variables are test seams, not user preferences.

## Security Boundary

- Desktop-launched servers require bearer authentication on every route, including static assets.
- The token is a random 32-byte owner-only credential and never enters renderer JavaScript.
- Portfolio and schedule mutations require both the bearer token and a same-origin request.
- Guided onboarding mutations use the same bearer-plus-same-origin boundary.
- The renderer runs with `contextIsolation`, sandboxing, and no Node integration.
- Navigation outside the local server is denied; HTTPS links open in the system browser.
- Remote Library API keys are stored in Keychain, Secret Service, or Windows Credential Manager
  when available. Configuration stores only the credential reference.

## Installed Inventory

`GET /api/v2/portfolio` discovers project, global, Codex, and managed skill packages before any
SelfTune telemetry exists. It joins that inventory to trusted local observations and returns an
evidence classification. Absence of observations remains `unobserved`, not `unused`.

Quarantine is an explicit, reversible package move. The desktop calls the same portfolio module as
the CLI, preserves the receipt and package hash, and exposes receipt-based restore. Protected
SelfTune, system, and administrator-managed packages cannot be quarantined.

## Settings And Automation

`GET /api/v2/settings` inspects the integration artifacts installed by SelfTune for Claude Code,
Codex, OpenCode, OpenClaw, and Pi. Detection and connection are separate states: finding a harness
binary or home directory does not claim that telemetry is connected unless the expected SelfTune
hooks, plugin, extension, or session source exists.

`POST /api/v2/settings/schedule` accepts only the three fixed SelfTune jobs and schedule forms that
both native adapters can represent. The sidecar reconciles launchd plists on macOS and systemd user
timers on Linux, then stores the versioned preference under `~/.selftune/schedule/`. Commands and
artifact paths are not supplied by renderer input. The dashboard presents these expressions as
human-readable presets and marks each job's default cadence as recommended.

`POST /api/v2/settings/onboarding` is the human setup boundary. It accepts only known import
sources, hook-capable harnesses, and the three fixed operating features. Import choices are stored
in `~/.selftune/onboarding.json` and become the defaults for manual sync, initialization backfills,
watch/evolve preparation, and autonomous runs. Hook choices reconcile only SelfTune-managed
entries; existing third-party hooks are preserved. Feature choices map directly to the sync,
daily-health, and autonomous-improvement native jobs.

First-run recommendations enable observability and daily health reporting while leaving autonomous
improvement off until the human opts in. Reopening onboarding preserves the saved choices and lets
the human migrate existing integrations to the current desktop runtime.
Until that first setup is saved, Electron opens Settings directly so the onboarding choice is not
hidden behind the default Overview route.

## Build And Packaging

From `apps/desktop`:

```bash
bun run build
bun run smoke:sidecar
bun run package:mac
```

`build:sidecar` compiles one `selftune` CLI executable with Bun, then stages it beside the dashboard
build under Electron resources. The daemon,
service manager, native scheduler artifacts, and installed harness hooks all point back to that
same CLI ownership boundary, so they keep working without a global npm or Bun install.

Runtime installation hashes every staged file, allows signing mutation only for the nested
executable inside a verified same-team Developer ID bundle, requires the installed copy to remain
byte-identical to that signed source, and rejects a non-executable Unix runtime even when its bytes
still match.

macOS release builds use hardened runtime, the explicit Electron/Bun entitlements in
`apps/desktop/build/entitlements.mac.plist`, Developer ID Application signing, and Apple
notarization. The release workflow expects these repository secrets:

- `DESKTOP_CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `DESKTOP_CSC_KEY_PASSWORD`: password for that `.p12`
- `DESKTOP_APPLE_API_KEY`: raw contents of the App Store Connect `.p8` key
- `DESKTOP_APPLE_API_KEY_ID`: App Store Connect key ID
- `DESKTOP_APPLE_API_ISSUER`: App Store Connect issuer ID

The workflow writes the `.p8` contents to an owner-only temporary file before invoking
electron-builder. Pull requests may produce unsigned packages, but a macOS release fails when any
signing or notarization credential is missing. Release credentials never enter the application
bundle.

electron-builder also emits signed ZIP installers, blockmaps, and per-platform update manifests.
The release workflow merges the arm64 and x64 entries into one `latest-mac.yml` before attaching
the artifacts to the GitHub release. Installed apps check at startup and every four hours, download
in the background, and offer an explicit restart once the update is staged. The menu-bar update
item exposes manual checks, progress, and restart without sending installed apps through npm.
