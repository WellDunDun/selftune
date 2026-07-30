# Library lifecycle E2E matrix

The Library parity suite has two deliberate execution paths:

- one unchanged server journey for Local, SelfTune Cloud, and Self-host capability providers;
- one Desktop-specific journey that launches a packaged Electron application and its Local runtime.

Desktop is not disguised as a server target. Both paths share the tracked-update fixture and assert the same installed revision plus an applied recovery receipt.

## Install the browser

```sh
bun run e2e:install
```

## Fixture contract

Every target fixture is a JSON file with:

```json
{
  "skill_name": "research",
  "installed_revision_hash": "old-tree",
  "expected_revision_hash": "new-tree",
  "expected_source_hash": "new-tree"
}
```

Fixture setup—not the scenario—owns the isolated tracked package, source lock, and upstream revision. Never point a mutation journey at a normal user account or normal home/config directory.

## Server targets

Run one target or the entire matrix:

```sh
SELFTUNE_E2E_LOCAL_FIXTURE=/absolute/path/to/local-fixture.json \
  bun run e2e:server-library local

bun run e2e:server-library cloud
bun run e2e:server-library selfhost
bun run e2e:server-library all
```

Local starts and owns the worktree dev stack. `SELFTUNE_E2E_ATTACH=1` attaches only to a manifest-verified Local stack and deliberately skips restart instead of stopping a contributor-owned process. The older `SELFTUNE_E2E_LIBRARY_FIXTURE` variable and `e2e:local-library` command remain compatible.

Cloud and Self-host always attach to deliberately provisioned instances. Configure each target by replacing `<TARGET>` with `CLOUD` or `SELFHOST`:

| Variable | Purpose |
| --- | --- |
| `SELFTUNE_E2E_<TARGET>_URL` | Dashboard origin for the isolated hosted instance |
| `SELFTUNE_E2E_<TARGET>_FIXTURE` | Target-owned tracked-update fixture JSON |
| `SELFTUNE_E2E_<TARGET>_STORAGE_STATE` | Optional Playwright storage-state file for dashboard authentication |
| `SELFTUNE_E2E_<TARGET>_TOKEN` | Optional bearer token for target API and restart calls |
| `SELFTUNE_E2E_<TARGET>_RESTART_URL` | Isolated test-only `POST` endpoint that restarts the target runtime |
| `SELFTUNE_E2E_CLOUD_LIBRARY_ITEM_ID` | Optional Cloud source ID to select when verifying inventory and detail; otherwise the first source is used |
| `SELFTUNE_E2E_CLOUD_SOURCE_UPDATE_CONTRACT` | Set to `local-v2` only for a deliberate Cloud test instance that exposes Local-style source-update review and apply |

Self-host uses the shared Library at `/skills`, the `GET /api/v2/library` projection, and the review/apply UI backed by `POST /api/v2/library/source-update/apply`.

SelfTune Cloud is intentionally different. A normal Cloud run first verifies the production inventory contract at `GET /api/v1/cloud-sources` and the selected source detail at `GET /api/v1/cloud-sources/:id`, writes `library-contract.json`, and then records a structured `source-update-review` skip. It does not call `/api/v2/library`, launch the mutation UI, or require fixture/restart configuration because the production Cloud adapter syncs snapshots automatically and does not claim Local source-update mutation.

To exercise the unchanged full server mutation journey against a deliberate Cloud test instance, configure its fixture and restart endpoint and set `SELFTUNE_E2E_CLOUD_SOURCE_UPDATE_CONTRACT=local-v2`. That opt-in asserts that the instance exposes the same test-only `/api/v2/library` and review/apply behavior as Self-host. A missing URL, read contract, Review action, browser authentication state, fixture, or restart endpoint becomes structured skip or failure metadata as appropriate. Mutation prerequisites are checked before any mutation.

Authentication secrets remain in request headers or Playwright storage state; they are not copied into result artifacts.

## Packaged Desktop

Build an unpacked, genuinely packaged Electron application and run it independently:

```sh
SELFTUNE_E2E_DESKTOP_FIXTURE=/absolute/path/to/desktop-fixture.json \
SELFTUNE_E2E_DESKTOP_HOME=/absolute/path/to/isolated/home \
SELFTUNE_E2E_DESKTOP_CONFIG_DIR=/absolute/path/to/isolated/config \
  bun run e2e:desktop-library:packaged
```

`e2e:desktop-library` runs an already packaged application. It discovers the platform-specific executable under `apps/desktop/dist-e2e`, or accepts `SELFTUNE_E2E_DESKTOP_APP=/absolute/path/to/the/executable`. The runner refuses a non-packaged Electron process, requires isolated Home and SelfTune config roots, assigns isolated Electron user data per run, disables updates/background installation, and opens `/skills` through the real packaged shell and Local sidecar.

The Desktop fixture must already exist inside the supplied isolated Home/config sandbox and include the same tracked package/source lock described by the fixture JSON. Missing application, fixture, or isolated sandbox produces a structured skip rather than touching ambient state.

## Results and CI split

Set `SELFTUNE_E2E_RUNS_ROOT` to relocate output. Otherwise each target writes to `e2e/runs/<target>/<scenario>/<run-id>/`:

- `result.json` and a copied scenario source;
- inventory, review, applied, and restarted screenshots where applicable;
- Playwright traces plus target/renderer/process logs;
- `recovery-receipt.json` for completed mutations;
- `library-contract.json` when Cloud inventory and detail verification completes;
- `skipped.json` with target, scenario, capability, reason, and timestamp.

`e2e/runs/matrix.json` keeps the latest result per target/scenario and includes a compact `parity` list with status, installed revision, receipt status, skip capability, or failed step. Passes, skips, and failures remain distinct.

CI can schedule these independently:

```sh
bun run test:e2e-contract
bun run e2e:server-library local
bun run e2e:server-library cloud
bun run e2e:server-library selfhost
bun run e2e:desktop-library:packaged
```
