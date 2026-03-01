# selftune Contribute Workflow

Export anonymized skill observability data as a JSON bundle for community
contribution. Helps improve selftune's skill routing without exposing
private data.

## When to Use

- Want to help improve selftune's skill routing
- Sharing anonymized usage patterns with the community
- Contributing eval data for skill evolution

## Default Command

```bash
selftune contribute --skill selftune
```

## Options

| Flag | Description |
|------|-------------|
| `--skill <name>` | Skill to contribute data for (default: "selftune") |
| `--output <path>` | Output file path (default: auto-generated in ~/.selftune/contributions/) |
| `--preview` | Show what would be shared without writing |
| `--sanitize <level>` | `conservative` (default) or `aggressive` |
| `--since <date>` | Only include data from this date onward |
| `--submit` | Auto-create GitHub Issue via `gh` CLI |

## Sanitization Levels

### Conservative (default)

| Pattern | Replacement |
|---------|-------------|
| File paths | `[PATH]` |
| Email addresses | `[EMAIL]` |
| API keys, tokens, JWTs | `[SECRET]` |
| IP addresses | `[IP]` |
| Project name from cwd | `[PROJECT]` |
| Session IDs | `[SESSION]` |

### Aggressive

Extends conservative with:

| Pattern | Replacement |
|---------|-------------|
| camelCase/PascalCase identifiers > 8 chars | `[IDENTIFIER]` |
| Quoted strings | `[STRING]` |
| Import/require module paths | `[MODULE]` |
| Queries > 200 chars | Truncated |

## Bundle Contents

The contribution bundle includes:
- **Positive queries** -- queries that triggered the skill (sanitized)
- **Eval entries** -- trigger eval set for the skill
- **Grading summary** -- aggregate pass rates (no raw transcripts)
- **Evolution summary** -- proposal counts and outcomes
- **Session metrics** -- average turns, tool usage, error rates

No raw transcripts, file contents, or identifiable information is included.

## Submission

- Default: writes JSON file to `~/.selftune/contributions/`
- `--submit`: creates a GitHub Issue with the bundle
  - Small bundles (< 50KB): inlined in issue body
  - Large bundles (>= 50KB): uploaded as a gist

## Steps

1. Run `selftune contribute --preview --skill selftune` to see what would be shared
2. Review the sanitized output
3. Run `selftune contribute --skill selftune` to write the bundle
4. Optionally: `selftune contribute --skill selftune --submit` to create GitHub issue

## Common Patterns

**"Preview what I'd share"**
> `selftune contribute --preview`

**"Use aggressive sanitization"**
> `selftune contribute --sanitize aggressive`

**"Submit directly to GitHub"**
> `selftune contribute --submit`

**"Only contribute recent data"**
> `selftune contribute --since 2026-02-01`
