# selftune Background Service Workflow

Install, inspect, repair, or remove the persistent SelfTune dashboard runtime.
The same `selftune` CLI binary owns the daemon and the OS service definition;
there is no separate sidecar executable to update.

## When to Use

- The desktop app should keep observing after its window closes
- SelfTune should start at login or boot
- The menu-bar app says the local service is unavailable
- An app or CLI update left the background runtime on an older version
- The local bearer token must be rotated

## Default Diagnosis

```bash
selftune service doctor --json
selftune service status --json
selftune daemon status --json
```

`service status` reports OS registration and process state. `daemon status`
also verifies the authenticated `/api/health` endpoint recorded in the durable
manifest. If the service is registered but the daemon is unreachable, restart
it once, then reinstall it if the restart does not repair the version or
executable path.

On Windows, `service doctor` reads the fixed current-user service-lock scope
without creating state. A `legacy_stale_repairable` result can be repaired with:

```bash
selftune service repair-lock --json
```

These two maintenance commands accept only `--json`. Never pass or derive a
state directory, lock path, PID, token, or force flag, and never delete the lock
file manually. Repair acquires the SQLite owner, reproves the exact stale legacy
generation in memory, and atomically installs the permanent compatibility fence.

## Install or Repair

```bash
selftune service install
selftune service restart
```

Installation is idempotent. A packaged desktop release first copies its signed,
manifest-verified runtime to a versioned stable application-support path, then
registers that executable. A direct CLI install registers the current CLI
executable. Before registration, an explicit install performs an authenticated
stop of the runtime using the same state directory so the new service takes
over the singleton cleanly. The platform backend is selected automatically:

| Platform | User-owned supervisor           |
| -------- | ------------------------------- |
| macOS    | LaunchAgent (`launchd`)         |
| Linux    | user service (`systemd --user`) |
| Windows  | Task Scheduler                  |

On Linux, installation may enable systemd user lingering so SelfTune can start
at boot without an interactive login. This is best-effort because some systems
require additional authorization.

Use `--port <port>` or `--config-dir <path>` only when the existing local
runtime already uses non-default values. `--boot` is Windows-only and requires
elevation. Linux boot persistence uses user lingering rather than this flag;
other default services start for the signed-in user. `--owner cli` and
`--owner desktop` are advanced integration flags. Normal CLI installs select
`cli`; the desktop app passes `desktop` itself.

Packaged integrations also pass `--executable`, `--resource-dir`, and
`--service-version` so the supervisor records the exact installed runtime.
Legacy desktop builds may still send `--version` as a compatibility alias;
root `selftune --version` reports the CLI version instead.

The durable manifest records ownership and supervision independently. A CLI
foreground daemon is `cli`-owned without an OS supervisor, a desktop child is
`desktop`-owned, and a persistent service can be owned by either installer.
The desktop attaches to an equal, newer, or unversioned registered service and
does not downgrade it. It replaces only a service with an older valid SelfTune
version. It also preserves a directly started CLI daemon on app quit and asks
the agent to stop that daemon before desktop-only restart or state-reset work.
A desktop child orphaned by an app crash is authenticated and stopped through
the canonical CLI before a later desktop instance replaces it. Cleanup is
bound to the recorded PID and runtime instance ID, so a successor CLI daemon
cannot be stopped by a delayed desktop or Windows service cleanup. Service
start and repair report success only after the authenticated manifest proves
that an OS-supervised runtime is healthy.

## Stop or Remove

```bash
selftune service stop
selftune service start
selftune service uninstall
```

`stop` preserves registration. `uninstall` removes only the supervisor
definition; it does not delete skills, telemetry, settings, credentials, or
the local database. Both operations preserve an independently started CLI
daemon even if it becomes active while the supervisor is shutting down.

On Linux, uninstall preserves user lingering because it is a user-global
setting that may keep other user services running. Only run
`loginctl disable-linger "$USER"` after considering those other services.

On Windows, stop, restart, reinstall, and uninstall verify the exact loopback
listener after Task Scheduler stops. SelfTune asks a surviving child to shut
itself down only when two fresh bearer-authenticated health checks match its PID,
port, runtime instance, owner, supervision mode, absolute executable identity,
and state directory. The shutdown request is bound to that runtime instance,
and final verification is scan-only so it cannot stop a successor. Ambiguous,
foreign, or unauthenticated listeners are preserved and the command reports a failure.
`uninstall` does not delete the scheduled task or launcher artifacts until the
old runtime and target port are proven absent.

Windows task discovery uses structured Task Scheduler inventory and stable
numeric result codes, so service control does not depend on the operating
system language. Scheduler, listener-inspection, and hidden-launcher commands
are resolved to validated absolute executables under `System32`.

Windows serializes every service mutation through one per-user SQLite ownership
lock, even when commands use different `--config-dir` values. The operating
system releases the lock if the owning process crashes or is forcibly stopped,
so recovery never depends on deleting or trusting a stale PID file.
Legacy pre-SQLite locks are fenced at their old path. Receipt and legacy cleanup
artifacts are atomically quarantined and verified before deletion; mismatches are
restored without overwriting replacements, and matching crash leftovers resume
under the durable receipt or cleanup journal.

`selftune uninstall` performs the complete teardown: it unregisters this
service and removes the Sync & Backup credential before deleting local state.

## Token Rotation

```bash
selftune daemon rotate-token
selftune service restart
```

Rotation writes a new owner-only local token. Restart immediately so the
daemon and desktop shell converge on the same credential. This token protects
the loopback dashboard and is separate from a SelfTune Cloud or self-hosted
Sync & Backup account token.

## Direct Daemon Commands

`selftune daemon run` is a low-level foreground runtime used by the service
manager and desktop fallback. Prefer `selftune service install` for persistent
operation. Use direct commands only for diagnosis or a foreground development
session:

```bash
selftune daemon run --port 7888 --hostname 127.0.0.1 --owner cli
selftune daemon status --json
selftune daemon stop
```

Never bind an unauthenticated daemon to a public interface. The persistent
desktop service is designed for authenticated loopback; use the documented
self-hosted container for remote access and backups.
