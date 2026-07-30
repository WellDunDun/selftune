# AlphaUpload Workflow

Use this workflow when the user or parent agent wants to manually push alpha data
to the selftune cloud or preview what would be sent.

## Command

```bash
selftune alpha upload [--dry-run]
```

## Flags

| Flag           | Meaning                                                         | Default |
| -------------- | --------------------------------------------------------------- | ------- |
| `--dry-run`    | Stage and summarize the upload without sending the HTTP request | Off     |
| `-h`, `--help` | Show command help                                               | Off     |

## Behavior

1. Read the local alpha identity from `~/.selftune/config.json`
2. Fail with guidance if alpha is not enrolled or the API key is missing
3. Stage new canonical records from local SQLite into `canonical_upload_staging`
4. Build V2 push envelopes and flush them to the cloud API
5. Print a JSON summary with `enrolled`, `prepared`, `sent`, `failed`, `skipped`, and optional `guidance`

`selftune sync` already triggers an upload cycle automatically when alpha is
enrolled. Use this workflow when you want a manual upload now or want to see a
dry-run summary of what SQLite-backed staging would send.

## Examples

Preview the upload:

```bash
selftune alpha upload --dry-run
```

Run the upload now:

```bash
selftune alpha upload
```

## Relink Cloud Credentials

```bash
selftune alpha relink
```

`relink` accepts no command-specific flags. It requests a device code, prints the
verification URL and user code as JSON to stdout, opens the browser when possible,
and polls for approval while progress is written to stderr. On approval it preserves
the local user ID, email, and display name, replaces the cloud IDs and upload key,
and keeps `~/.selftune/config.json` restricted to the current user.

Use `selftune alpha relink --help` to inspect the command without starting the
device-code flow.

## When To Use

- The user wants to manually push data before waiting for `orchestrate`
- `selftune status` or `selftune doctor` shows failed or pending alpha uploads
- You want to confirm what will be uploaded without sending data yet
- The upload credential was revoked or must be replaced
