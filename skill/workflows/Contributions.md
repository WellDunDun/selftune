# selftune Contributions Workflow

Manage local preferences for future creator-directed contribution flows.

This is **not** the same as `selftune contribute`:
- `selftune contributions` manages per-skill opt-in choices for creator-directed sharing
- `selftune contribute` exports a community contribution bundle
- `selftune creator-contributions` manages the creator-side `selftune.contribute.json` file

## When to Use

- The user asks to approve or revoke sharing signals with a specific skill creator
- The user wants to see which creator-directed contribution preferences are stored locally
- The user wants to set a default behavior for future creator-directed contribution prompts

## Default Commands

```bash
selftune contributions
selftune contributions preview <skill>
selftune contributions approve <skill>
selftune contributions revoke <skill>
selftune contributions default <ask|always|never>
selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>]
```

## What It Does Today

- Discovers installed skills that ship a `selftune.contribute.json` config
- Stores local opt-in / opt-out state in `~/.selftune/contribution-preferences.json`
- Stages privacy-safe creator-directed relay signals locally during `selftune sync` once a skill is approved
- Keeps creator-directed sharing preferences separate from:
  - `selftune contribute` community export bundles
  - `selftune alpha upload` personal cloud uploads

## Commands

| Command | Description |
| --- | --- |
| `selftune contributions` | Show current creator-directed contribution preferences |
| `selftune contributions status` | Same as above |
| `selftune contributions preview <skill>` | Show the privacy-safe relay payload shape for one skill |
| `selftune contributions approve <skill>` | Approve creator-directed sharing for one skill |
| `selftune contributions revoke <skill>` | Revoke creator-directed sharing for one skill |
| `selftune contributions default <ask|always|never>` | Set the default behavior for future creator-directed prompts |
| `selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>]` | Flush locally staged creator-directed relay signals |
| `selftune contributions reset` | Reset all creator-directed sharing preferences to defaults |

## Upload Flags

| Flag | Type | Description |
| --- | --- | --- |
| `--dry-run` | Boolean | Show pending staged rows without uploading |
| `--retry-failed` | Boolean | Requeue failed rows before attempting upload |
| `--limit <n>` | Integer | Maximum number of staged rows to upload in one run |

## Notes

- This workflow now shows which installed skills are requesting creator-directed sharing via `selftune.contribute.json`.
- Once approved, creator-directed contribution signals are staged locally during `selftune sync` / `selftune orchestrate`.
- Use `selftune contributions upload` to flush staged rows to the creator-directed relay endpoint.
- Relay upload is separate from `selftune alpha upload` and currently reuses the local cloud API key when available.
- Use `selftune contribute` when the user explicitly wants to export/share an anonymized community bundle.
- Use `selftune alpha upload` when the user wants to push their own cloud telemetry.

## Common Patterns

**User asks what creator-directed sharing is configured**

> Run `selftune contributions` and summarize the global default plus any per-skill choices.

**User wants to allow contribution signals for one skill**

> Run `selftune contributions approve <skill>`.

**User wants to see what would actually be shared**

> Run `selftune contributions preview <skill>` and summarize the requested signals plus the “never shared” guarantees.

**User wants to turn off creator-directed sharing for one skill**

> Run `selftune contributions revoke <skill>`.

**User wants future creator-directed prompts to default one way**

> Run `selftune contributions default <ask|always|never>` using the user's preference.

**User wants to send staged creator-directed signals now**

> Run `selftune contributions upload`.
> Use `--dry-run` first if they want to confirm how many staged rows are pending.
> Use `--retry-failed` if earlier relay attempts failed and need to be retried.
> Use `--limit 25` when they want a smaller controlled batch.

**User wants to clear all stored creator-directed contribution preferences**

> Run `selftune contributions reset`.
