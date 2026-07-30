# `@selftune/api-contract`

Effect 4 HTTP contracts for the shared selftune application.

This package owns wire data, Effect Schema validation, tagged HTTP failures, the
canonical `HttpApi`, and its generated client. It does not import Hono, React,
authentication SDKs, persistence, or product screens. React consumes the small
Promise facade; legacy runtimes consume plain decode results so Effect runtime
values do not cross their boundary.

## Initial surface

- `CloudBootstrapSchema` exactly matches the existing Cloud v2 bootstrap service
  result.
- `SelfTuneCloudApi` defines the canonical greenfield endpoint graph.
- `createCloudApiClient` wraps the generated `HttpApiClient` and accepts injected
  authentication, organization selection, and fetch functions.

The Cloudflare Worker implements the canonical API and validates the temporary
Hono upstream on every successful response. Hono uses this package's plain
decode adapter rather than importing Effect 4 runtime values into its Effect 3
graph. The frozen Cloud v2 donor still carries legacy schemas; remove those as
their endpoint families move to the greenfield Cloud Host.
