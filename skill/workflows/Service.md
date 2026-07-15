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
selftune service status --json
selftune daemon status --json
```

`service status` reports OS registration and process state. `daemon status`
also verifies the authenticated `/api/health` endpoint recorded in the durable
manifest. If the service is registered but the daemon is unreachable, restart
it once, then reinstall it if the restart does not repair the version or
executable path.

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

Use `--port <port>` or `--config-dir <path>` only when the existing local
runtime already uses non-default values. `--boot` is Windows-only and requires
elevation; the normal default starts for the signed-in user. `--owner cli` and
`--owner desktop` are advanced integration flags. Normal CLI installs select
`cli`; the desktop app passes `desktop` itself.

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

`selftune uninstall` performs the complete teardown: it unregisters this
service and removes the Remote Library credential before deleting local state.

## Token Rotation

```bash
selftune daemon rotate-token
selftune service restart
```

Rotation writes a new owner-only local token. Restart immediately so the
daemon and desktop shell converge on the same credential. This token protects
the loopback dashboard and is separate from a hosted or self-hosted Remote
Library account token.

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
