# selftune Contributions Workflow

Manage local preferences for future creator-directed contribution flows.

This is **not** the same as `selftune contribute`:
- `selftune contributions` manages per-skill opt-in choices for creator-directed sharing
- `selftune contribute` exports a community contribution bundle

## When to Use

- The user asks to approve or revoke sharing signals with a specific skill creator
- The user wants to see which creator-directed contribution preferences are stored locally
- The user wants to set a default behavior for future creator-directed contribution prompts

## Default Commands

```bash
selftune contributions
selftune contributions approve <skill>
selftune contributions revoke <skill>
selftune contributions default <ask|always|never>
```

## What It Does Today

- Discovers installed skills that ship a `selftune.contribute.json` config
- Stores local opt-in / opt-out state in `~/.selftune/contribution-preferences.json`
- Keeps creator-directed sharing preferences separate from:
  - `selftune contribute` community export bundles
  - `selftune alpha upload` personal cloud uploads

## Commands

| Command | Description |
| --- | --- |
| `selftune contributions` | Show current creator-directed contribution preferences |
| `selftune contributions status` | Same as above |
| `selftune contributions approve <skill>` | Approve creator-directed sharing for one skill |
| `selftune contributions revoke <skill>` | Revoke creator-directed sharing for one skill |
| `selftune contributions default <ask|always|never>` | Set the default behavior for future creator-directed prompts |
| `selftune contributions reset` | Reset all creator-directed sharing preferences to defaults |

## Notes

- This workflow now shows which installed skills are requesting creator-directed sharing via `selftune.contribute.json`.
- It still sets local preference only. It does not yet upload creator-directed contribution signals by itself.
- Use `selftune contribute` when the user explicitly wants to export/share an anonymized community bundle.
- Use `selftune alpha upload` when the user wants to push their own cloud telemetry.

## Common Patterns

**User asks what creator-directed sharing is configured**

> Run `selftune contributions` and summarize the global default plus any per-skill choices.

**User wants to allow contribution signals for one skill**

> Run `selftune contributions approve <skill>`.

**User wants to turn off creator-directed sharing for one skill**

> Run `selftune contributions revoke <skill>`.

**User wants future creator-directed prompts to default one way**

> Run `selftune contributions default <ask|always|never>` using the user's preference.
