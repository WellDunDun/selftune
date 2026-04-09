# selftune Creator-Contributions Workflow

Manage the **creator sharing setup** — the `selftune.contribute.json` file
bundled with a skill package.

This is **not** the same as:
- `selftune contributions` — end-user **sharing preferences** (opt-in / opt-out)
- `selftune contribute` — community **export bundle** (anonymized data export)
- The community dashboard — viewing aggregated **community data** from all contributors

## When to Use

- The user is a skill creator and wants to enable creator-directed contribution for one skill
- The user wants to inspect or remove a bundled `selftune.contribute.json`
- The user wants to prepare a skill package for the future creator ← user relay pipeline

## Default Commands

```bash
selftune creator-contributions
selftune creator-contributions status --skill <name>
selftune creator-contributions enable --skill <name> [--skill-path <path>] [--creator-id <id>]
selftune creator-contributions enable --all [--prefix sc-] [--creator-id <id>]
selftune creator-contributions disable --skill <name> [--skill-path <path>]
```

## Options

| Flag | Description |
| --- | --- |
| `--skill <name>` | Skill name to inspect or configure |
| `--skill-path <path>` | Explicit path to the skill's `SKILL.md` when auto-discovery is ambiguous |
| `--creator-id <id>` | Explicit creator ID. If omitted, selftune uses `alpha.cloud_user_id` from local config when available |
| `--signals <csv>` | Comma-separated signal list for the generated config |
| `--message <text>` | Custom opt-in note stored in the config |
| `--privacy-url <url>` | Optional creator privacy URL stored in the config |
| `--all` | Enable configs for every installed skill selftune can resolve |
| `--prefix <prefix>` | Limit `--all` to installed skills whose names start with this prefix |

## What It Does Today

- Discovers installed skills that already ship `selftune.contribute.json`
- Creates or removes that config file locally for a creator-owned skill
- Can bulk-enable configs for multiple installed skills (useful for a skill suite like `sc-*`)
- Uses a static JSON config only — no executable creator code

## Notes

- This is local packaging/setup only. It does **not** upload creator-directed signals yet.
- The `creator_id` field must be the creator's cloud user UUID (the `cloud_user_id` from alpha enrollment). This is the canonical identifier used to route signals back to the correct creator account.
- The creator ID is sourced from `--creator-id` or the local alpha identity's `cloud_user_id`.
- Use this workflow when the user is preparing a skill package.

## Selftune Dogfood Config

The selftune skill itself ships a bundled `selftune.contribute.json` at
`oss/selftune/skill/selftune.contribute.json`. This is the selftune project
dogfooding its own creator-directed relay flow. The `creator_id` field is
set to the production selftune creator's cloud user UUID.

## Common Patterns

**User wants to see which of their skills already request creator contributions**

> Run `selftune creator-contributions` and summarize the discovered configs.
> Example: `selftune creator-contributions status --skill sc-search`

**User wants to enable creator contributions for one skill**

> Run `selftune creator-contributions enable --skill <name>`.
> If auto-discovery fails, rerun with `--skill-path /path/to/SKILL.md`.
> If no creator identity is available locally, rerun with `--creator-id <id>`.
> Example: `selftune creator-contributions enable --skill sc-search --skill-path ./skills/sc-search/SKILL.md --creator-id cr_state_change --signals trigger,grade,miss_category --message "Share privacy-safe usage signals with the skill creator." --privacy-url https://statechange.ai/privacy`

**User wants to enable creator contributions for a whole installed skill suite**

> Run `selftune creator-contributions enable --all --prefix sc-`.
> This is the fastest path when preparing a whole family of skills like State Change skills.
> Example: `selftune creator-contributions enable --all --prefix sc- --creator-id cr_state_change`

**User wants to stop bundling creator contribution config**

> Run `selftune creator-contributions disable --skill <name>`.
> Example: `selftune creator-contributions disable --skill sc-search --skill-path ./skills/sc-search/SKILL.md`
