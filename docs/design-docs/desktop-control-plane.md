<!-- Verified: 2026-07-14 -->

# Desktop Control Plane

SelfTune Desktop packages the existing local dashboard as a native Electron app. It follows the
same sidecar architecture used by Executor: Electron owns process lifecycle and window security,
while one compiled Bun executable owns the local API, SQLite access, skill discovery, and SPA
assets.

## Runtime

```text
Electron main
  -> loads or creates ~/.selftune/server-control/auth.json (0600)
  -> starts selftune-sidecar on 127.0.0.1:0
  -> waits for SELFTUNE_READY:<port>
  -> writes ~/.selftune/server-control/server.json (0600)
  -> injects Authorization: Bearer <token> in a dedicated Electron session
  -> opens the sidecar URL in BrowserWindow
```

The CLI, browser dashboard, and desktop share `~/.selftune` and the same SQLite database. Electron
does not introduce a second application database or duplicate business logic.

## Security Boundary

- Desktop-launched servers require bearer authentication on every route, including static assets.
- The token is a random 32-byte owner-only credential and never enters renderer JavaScript.
- Portfolio mutations require both the bearer token and a same-origin request.
- The renderer runs with `contextIsolation`, sandboxing, and no Node integration.
- Navigation outside the local server is denied; HTTPS links open in the system browser.

## Installed Inventory

`GET /api/v2/portfolio` discovers project, global, Codex, and managed skill packages before any
SelfTune telemetry exists. It joins that inventory to trusted local observations and returns an
evidence classification. Absence of observations remains `unobserved`, not `unused`.

Quarantine is an explicit, reversible package move. The desktop calls the same portfolio module as
the CLI, preserves the receipt and package hash, and exposes receipt-based restore. Protected
SelfTune, system, and administrator-managed packages cannot be quarantined.

## Build And Packaging

From `apps/desktop`:

```bash
bun run build
bun run smoke:sidecar
bun run package:mac
```

`build:sidecar` compiles `cli/selftune/dashboard-server.ts` with Bun and stages the dashboard build
beside it under Electron resources.

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
