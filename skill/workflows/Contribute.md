# selftune Contribute Workflow

Export an anonymized **export bundle** of skill observability data for
community contribution. Helps improve selftune's skill routing without
exposing private data.

This is **not** the same as:
- `selftune contributions` — managing your **sharing preferences** for creator-directed signals
- `selftune creator-contributions` — managing the **creator sharing setup** file (`selftune.contribute.json`)
- The community dashboard — viewing aggregated **community data** from all contributors

## When to Use

- The user asks to contribute data, share usage patterns, or help improve selftune
- The user wants to export anonymized skill observability data
- The agent needs to submit eval data for community skill evolution

## Default Command

```bash
selftune contribute --skill selftune
```

## Options

| Flag                 | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `--skill <name>`     | Skill to contribute data for (default: "selftune")                       |
| `--output <path>`    | Output file path (default: auto-generated in ~/.selftune/contributions/) |
| `--preview`          | Show what would be shared without writing                                |
| `--sanitize <level>` | `conservative` (default) or `aggressive`                                 |
| `--since <date>`     | Only include data from this date onward                                  |
| `--submit`           | Submit bundle to the cloud endpoint (falls back to GitHub if it fails)   |
| `--endpoint <url>`   | Override the default cloud API endpoint                                  |
| `--github`           | Submit via GitHub Issue instead of the cloud endpoint                     |

## Sanitization Levels

### Conservative (default)

| Pattern                | Replacement |
| ---------------------- | ----------- |
| File paths             | `[PATH]`    |
| Email addresses        | `[EMAIL]`   |
| API keys, tokens, JWTs | `[SECRET]`  |
| IP addresses           | `[IP]`      |
| Project name from cwd  | `[PROJECT]` |
| Session IDs            | `[SESSION]` |

### Aggressive

Extends conservative with:

| Pattern                                    | Replacement    |
| ------------------------------------------ | -------------- |
| camelCase/PascalCase identifiers > 8 chars | `[IDENTIFIER]` |
| Quoted strings                             | `[STRING]`     |
| Import/require module paths                | `[MODULE]`     |
| Queries > 200 chars                        | Truncated      |

## Bundle Contents

The contribution bundle includes:

- **Positive queries** -- queries that triggered the skill (sanitized)
- **Eval entries** -- trigger eval set for the skill
- **Grading summary** -- aggregate pass rates (no raw transcripts)
- **Evolution summary** -- proposal counts and outcomes
- **Session metrics** -- average turns, tool usage, error rates

No raw transcripts, file contents, or identifiable information is included.

## Submission

- Default: writes the export bundle JSON file to `~/.selftune/contributions/`
- `--submit`: submits the export bundle to the cloud endpoint (`POST /api/v1/community/bundles`)
  - Requires a `selftune.contribute.json` with a valid `creator_id` in the skill directory
  - Uses the local alpha API key for authentication when available
  - Falls back to GitHub Issue submission if the cloud endpoint is unreachable
- `--github`: explicitly submits via GitHub Issue instead of the cloud endpoint
  - Small bundles (< 50KB): inlined in issue body
  - Large bundles (>= 50KB): uploaded as a gist

## Steps

1. Run `selftune contribute --preview --skill selftune` to preview the contribution bundle
2. Parse the output and report the sanitized data summary to the user for review
3. Run `selftune contribute --skill selftune` to write the bundle
4. If the user wants to submit directly, run `selftune contribute --skill selftune --submit`

## Common Patterns

**User wants to see what would be shared**

> Run `selftune contribute --preview`. Parse the output and report the
> sanitized data summary to the user before proceeding.

**User requests stronger anonymization**

> Run `selftune contribute --sanitize aggressive`. This replaces identifiers,
> quoted strings, and module paths in addition to standard PII scrubbing.

**User wants to submit directly**

> Run `selftune contribute --submit`. This submits the export bundle to the
> cloud endpoint. If the cloud endpoint fails, it falls back to GitHub.

**User wants to submit via GitHub explicitly**

> Run `selftune contribute --submit --github`. This creates a GitHub Issue
> via `gh` CLI with the bundle inlined or uploaded as a gist.

**User wants to limit to recent data**

> Run `selftune contribute --since <date>` with the user's specified date.
