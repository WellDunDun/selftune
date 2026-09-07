# Local sandbox checks

From the OSS root:

```sh
bun run e2e:install
bun run tests/sandbox/run-sandbox.ts
```

The runner starts each maintained suite in a separate process with a fresh home
and SelfTune config directory. It retains the installed Playwright browser cache;
`PLAYWRIGHT_BROWSERS_PATH` can override that cache. Missing browsers fail the run.
It does not install background jobs, call model providers, or contact the retired
hosted badge service.

Coverage includes blank-home CLI installation, CLI routing, doctor, status, last,
hook-to-eval generation, contribution preview, local badge output, all three
telemetry hooks, hook dispatch, OpenClaw ingestion, cron configuration, and the
Library update browser/API journey. Each suite owns its fixtures and assertions;
the runner does not duplicate them against legacy JSONL output.

Every suite must pass. A suite timeout is a failure. Reports are saved under
`tests/sandbox/results/`; temporary homes are removed even on failure. Pass
`--keep` to retain those homes for investigation.

The former handwritten runner used retired CLI paths and treated some network
failures as passes. Its supported journeys now use the maintained suites listed
in `run-sandbox.ts`. Shared Docker fixtures remain in `fixtures/`.
