# selftune Creator-Contributions Workflow

Manage the **creator sharing setup** — the `selftune.contribute.json` file
bundled with a skill package. By default, setup also writes a portable
`selftune-feedback.mjs` helper and `selftune.feedback.json` manifest so
downstream agents can submit privacy-safe signals without a full selftune CLI
install.

This is **not** the same as:

- `selftune contributions` — end-user **sharing preferences** (opt-in / opt-out)
- `selftune contribute` — community **export bundle** (anonymized data export)
- The signals dashboard — viewing aggregated **contributor signal data** from all contributors

## When to Use

- The user is a skill creator and wants to enable creator-directed contribution for one skill
- The user wants to inspect or remove a bundled `selftune.contribute.json`
- The user wants to prepare a skill package for the future creator ← user relay pipeline

## Default Commands

```bash
selftune creator-contributions
selftune creator-contributions status --skill <name>
selftune creator-contributions enable --skill <name> [--skill-path <path>] [--creator-id <id>] [--no-helper]
selftune creator-contributions enable --all [--prefix sc-] [--creator-id <id>] [--no-helper]
selftune creator-contributions disable --skill <name> [--skill-path <path>]
```

## Options

| Flag                        | Description                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--skill <name>`            | Skill name to inspect or configure                                                                    |
| `--skill-path <path>`       | Explicit path to the skill's `SKILL.md` when auto-discovery is ambiguous                              |
| `--creator-id <id>`         | Explicit creator ID. If omitted, selftune uses `alpha.cloud_user_id` from local config when available |
| `--signals <csv>`           | Comma-separated signal list for the generated config                                                  |
| `--message <text>`          | Custom opt-in note stored in the config                                                               |
| `--privacy-url <url>`       | Optional creator privacy URL stored in the config                                                     |
| `--feedback-endpoint <url>` | Override the public helper endpoint for generated `selftune-feedback.mjs`                             |
| `--no-helper`               | Write only `selftune.contribute.json`, without the portable helper                                    |
| `--all`                     | Enable configs for every installed skill selftune can resolve                                         |
| `--prefix <prefix>`         | Limit `--all` to installed skills whose names start with this prefix                                  |

## What It Does Today

- Discovers installed skills that already ship `selftune.contribute.json`
- Creates or removes that config file locally for a creator-owned skill
- Writes a portable helper by default:
  - `selftune-feedback.mjs`
  - `selftune.feedback.json`
- Can bulk-enable configs for multiple installed skills (useful for a skill suite like `sc-*`)
- Keeps executable behavior Selftune-owned — the helper is generated from the
  same template for every skill and only sends bucketed signals

## Notes

- This is local packaging/setup only. The generated helper uploads only after
  first-run consent or an explicit `--yes` flag from an agent that has already
  obtained user approval.
- The `creator_id` field must be the public Creator ID shown by the creator dashboard. This is the canonical routing identifier and is not a login or database user ID.
- The creator ID is sourced from `--creator-id` or the local alpha identity's `cloud_user_id`.
- Full selftune installs still use the richer `selftune contributions approve`,
  `selftune sync`, and relay upload path.
- Use this workflow when the user is preparing a skill package.
- For the full creator lifecycle, read `references/creator-playbook.md` before shipping.

## Selftune Dogfood Config

The selftune skill itself ships a bundled `selftune.contribute.json` at
`oss/selftune/skill/selftune.contribute.json`. This is the selftune project
dogfooding its own creator-directed relay flow. The `creator_id` field is
set to the production SelfTune public Creator ID.

## Common Patterns

**User wants to see which of their skills already request creator contributions**

> Run `selftune creator-contributions` and summarize the discovered configs.
> Example: `selftune creator-contributions status --skill sc-search`

**User wants to enable creator contributions for one skill**

> Run `selftune creator-contributions enable --skill <name>`.
> If auto-discovery fails, rerun with `--skill-path /path/to/SKILL.md`.
> If no creator identity is available locally, rerun with `--creator-id <id>`.
> The command rejects non-UUID creator IDs and unsupported signal names.
> By default, the command also writes `selftune-feedback.mjs`. Use
> `--no-helper` only when the user explicitly wants the connected-install flow
> without portable no-CLI feedback.
> Example: `selftune creator-contributions enable --skill sc-search --skill-path ./skills/sc-search/SKILL.md --creator-id 550e8400-e29b-41d4-a716-446655440000 --signals trigger,grade,miss_category --message "Share privacy-safe usage signals with the skill creator." --privacy-url https://statechange.ai/privacy`

**User wants to enable creator contributions for a whole installed skill suite**

> Run `selftune creator-contributions enable --all --prefix sc-`.
> This is the fastest path when preparing a whole family of skills like State Change skills.
> Example: `selftune creator-contributions enable --all --prefix sc- --creator-id 550e8400-e29b-41d4-a716-446655440000`

**User wants to stop bundling creator contribution config**

> Run `selftune creator-contributions disable --skill <name>`.
> Example: `selftune creator-contributions disable --skill sc-search --skill-path ./skills/sc-search/SKILL.md`
