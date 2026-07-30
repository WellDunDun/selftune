# SelfTune Use-once Helper

This is a separate, ephemeral helper for running a shared skill exactly once. It is not a
SelfTune Desktop component or a `selftune` CLI command. It accepts only a 43-character use-once
handoff token and an explicit supported agent, stages a canonical portable package in an owned OS
temporary directory, launches that agent with fixed arguments (never a shell), and removes the
workspace after the process exits or is interrupted.

The production composition talks only to the signed-in build's fixed
`https://cloud.selftune.dev` authority origin. There is no environment variable, command-line
option, redirect, or caller URL that can replace it. If the HTTPS SelfTune origin pin is invalid or
unavailable, the helper fails closed. The `UseOnceAuthorityClient` interface in
`src/contracts.ts` has no caller-provided URL, filesystem path, command, capability, cookie,
organization header, or telemetry credential.

The fixed protocol order is preview, pre-consume exact-object retrieval and canonical validation,
full interactive disclosure, staging under a live heartbeat lease, atomic consume, then one fixed
agent invocation. The handoff token belongs only in the preview JSON and the content request's
`Authorization` header—never a URL. Content uses
`application/vnd.selftune.portable-package+json`; canonical V2 is enforced from the bytes rather
than encoded into the MIME type. Preview and consume use bounded JSON responses; content validates
its declared length, body hash, ETag, and every preview binding header before staging. Requests omit
cookies and organization headers, disable caching and redirects, and have abortable timeouts. Any
post-consume failure ends the attempt and never retries agent execution.

Run it from an interactive terminal with only an explicit token and agent:

```sh
selftune-use-once --token <43-character-handoff-token> --agent codex
```

Supported agents are `codex`, `claude_code`, `opencode`, `openclaw`, and `pi`. The helper displays
the verified publisher, rights holder, license, bundled terms, provenance, telemetry policy, and
lifecycle policy. It proceeds only after the recipient types the exact confirmation `USE ONCE`.

## Release artifact

`bun run build` compiles an independent executable. Release automation must then run
`bun run release:manifest -- --artifact <path> --target <target> --private-key <ed25519-pem> --key-id <kid>`.
This creates a signed manifest binding the stable package identity, version, target, artifact name,
byte length, and SHA-256. Cloud should pin both the trusted key id and exact manifest/artifact hash.

This helper creates no install receipt, persistent skill copy, secure credential, or trusted
telemetry channel. Contributor signals, when disclosed and consented, remain
`portable_unverified`; lifecycle reporting is limited to the server's separately consented
`used_once_status` result.
