# Badge Command

Generate skill health badges for embedding in READMEs and documentation.

## Usage

```bash
selftune badge --skill <name> [--format svg|markdown|url] [--output <path>]
```

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--skill` | Yes | -- | Skill name to generate badge for |
| `--format` | No | `svg` | Output format: `svg`, `markdown`, or `url` |
| `--output` | No | stdout | Write output to file |
| `--help` | No | -- | Show usage information |

## Examples

### Generate SVG badge
```bash
selftune badge --skill my-skill --format svg > badge.svg
```

### Get markdown for README
```bash
selftune badge --skill my-skill --format markdown
```
Output: `![Skill Health: my-skill](https://img.shields.io/badge/Skill%20Health-87%25%20%E2%86%91-4c1)`

### Get shields.io URL
```bash
selftune badge --skill my-skill --format url
```

### Write badge to file
```bash
selftune badge --skill my-skill --output badge.svg
```

## Badge Colors

| Pass Rate | Color | Hex |
|-----------|-------|-----|
| > 80% | Green | `#4c1` |
| 60-80% | Yellow | `#dfb317` |
| < 60% | Red | `#e05d44` |
| No data | Gray | `#9f9f9f` |

## Embedding in README

Add to your skill's README.md:
```markdown
![Skill Health: my-skill](https://img.shields.io/badge/Skill%20Health-87%25%20%E2%86%91-4c1)
```

Or use the generated SVG directly for offline rendering.

## Dashboard Routes (Phase 2)

The local dashboard server exposes badge and report routes:

### GET /badge/:skillName

Returns a live SVG badge computed from local telemetry logs.

```
http://localhost:<port>/badge/my-skill
```

- Returns `image/svg+xml` with `Cache-Control: no-cache, no-store`
- Returns a gray "not found" badge (not JSON 404) for unknown skills

### GET /report/:skillName

Returns an HTML report page with pass rate, trend, session count, and embed code.

```
http://localhost:<port>/report/my-skill
```

## Hosted Service (Phase 3)

The hosted badge service at `selftune.dev` aggregates community contributions and serves badges publicly.

### Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/badge/:skill` | GET | SVG badge from aggregated community data |
| `/report/:skill` | GET | HTML report with contributor stats |
| `/submit` | POST | Accept contribution bundles |
| `/health` | GET | Service health check |

### Embedding from hosted service

```markdown
![Skill Health: my-skill](https://selftune.dev/badge/my-skill)
```

### Contributing data

```bash
selftune contribute --submit --skill my-skill
```

Uses `--endpoint` to target a custom service URL, with `--github` as fallback.
