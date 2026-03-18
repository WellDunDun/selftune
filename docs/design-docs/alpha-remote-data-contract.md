<!-- Verified: 2026-03-18 -->

# Alpha Remote Data Contract — D1 Schema, Upload Payload, Queue Model

**Status:** Draft
**Created:** 2026-03-18
**Type:** Spike (documentation + type definitions only, no runtime code)

---

## 1. Overview

### What the alpha remote pipeline does

The alpha remote pipeline enables opted-in selftune users to upload consent-based telemetry data to a shared Cloudflare D1 database. This data powers aggregate analysis across the alpha cohort: which skills trigger reliably, which evolution proposals improve outcomes, and where the selftune feedback loop breaks down across real-world usage patterns.

The pipeline is batch-oriented and asynchronous. Local SQLite remains the source of truth. Uploads happen periodically during `orchestrate` runs or explicit `selftune sync --upload` invocations, not in real time.

### Why Cloudflare D1

- **Edge-native SQL.** D1 is SQLite at the edge, which means the query semantics match selftune's local SQLite store exactly. No impedance mismatch between local and remote schemas.
- **Zero-config.** No connection pooling, no replica management, no VPC peering. A single Cloudflare Worker fronts the database.
- **Low cost for alpha volume.** D1's free tier covers the expected alpha cohort (tens of users, thousands of records per day). No cost risk during validation.
- **Workers integration.** The upload endpoint is a Cloudflare Worker that validates payloads, enforces consent, and writes to D1. One deployment artifact.

### Relationship to the existing `contribute/` system

The `contribute/` system and the alpha upload pipeline serve different purposes and should not be conflated:

| Dimension | `contribute/` | Alpha upload |
|-----------|---------------|--------------|
| **Purpose** | Community sharing of anonymized eval data via GitHub PRs | Automatic telemetry for alpha cohort analysis |
| **Trigger** | Manual (`selftune contribute`) | Automatic (each `orchestrate` run) |
| **Transport** | GitHub API (PR creation) | HTTPS to Cloudflare Worker |
| **Storage** | GitHub repository (JSONL files) | Cloudflare D1 (SQL tables) |
| **Consent model** | Per-invocation confirmation | Enrollment flag in config (`config.alpha.enrolled`) |
| **Data granularity** | Skill-level bundles with eval entries | Session-level, invocation-level, evolution-level records |
| **Privacy level** | Conservative or aggressive sanitization | Explicit alpha consent for raw prompt/query text plus structured telemetry |

Both systems still share config/version metadata and schema conventions, but the alpha pipeline deliberately keeps raw query text for the friendly alpha cohort instead of applying the `contribute/` sanitization pipeline.

---

## 2. D1 Schema

Four tables store the alpha telemetry data. All timestamps are ISO 8601 strings (TEXT). The schema mirrors the local SQLite conventions from `cli/selftune/localdb/schema.ts`.

### `alpha_users` --- user registry

```sql
CREATE TABLE alpha_users (
  user_id           TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  display_name      TEXT,
  agent_type        TEXT,
  selftune_version  TEXT,
  enrolled_at       TEXT NOT NULL,
  last_upload_at    TEXT
);
```

### `alpha_sessions` --- session summaries

```sql
CREATE TABLE alpha_sessions (
  session_id            TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  platform              TEXT,
  model                 TEXT,
  workspace_hash        TEXT,
  started_at            TEXT,
  ended_at              TEXT,
  total_tool_calls      INTEGER,
  assistant_turns       INTEGER,
  errors_encountered    INTEGER,
  skills_triggered_json TEXT,
  completion_status     TEXT,
  uploaded_at           TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id)
);
```

### `alpha_skill_invocations` --- core analysis table

```sql
CREATE TABLE alpha_skill_invocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  occurred_at       TEXT NOT NULL,
  skill_name        TEXT NOT NULL,
  invocation_mode   TEXT,
  triggered         INTEGER NOT NULL,
  confidence        REAL,
  query_text        TEXT,
  skill_scope       TEXT,
  source            TEXT,
  uploaded_at       TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id),
  FOREIGN KEY (session_id) REFERENCES alpha_sessions(session_id)
);
```

### `alpha_evolution_outcomes` --- what worked

```sql
CREATE TABLE alpha_evolution_outcomes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  proposal_id       TEXT NOT NULL,
  skill_name        TEXT NOT NULL,
  action            TEXT NOT NULL,
  before_pass_rate  REAL,
  after_pass_rate   REAL,
  net_change        REAL,
  deployed          INTEGER,
  rolled_back       INTEGER,
  timestamp         TEXT NOT NULL,
  uploaded_at       TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id)
);
```

### Indexes

```sql
-- alpha_sessions: lookup by user, by timestamp
CREATE INDEX idx_alpha_sessions_user ON alpha_sessions(user_id);
CREATE INDEX idx_alpha_sessions_uploaded ON alpha_sessions(uploaded_at);
CREATE INDEX idx_alpha_sessions_started ON alpha_sessions(started_at);

-- alpha_skill_invocations: the primary analysis table, indexed heavily
CREATE INDEX idx_alpha_inv_user ON alpha_skill_invocations(user_id);
CREATE INDEX idx_alpha_inv_session ON alpha_skill_invocations(session_id);
CREATE INDEX idx_alpha_inv_skill ON alpha_skill_invocations(skill_name);
CREATE INDEX idx_alpha_inv_occurred ON alpha_skill_invocations(occurred_at);
CREATE INDEX idx_alpha_inv_uploaded ON alpha_skill_invocations(uploaded_at);
CREATE INDEX idx_alpha_inv_skill_triggered ON alpha_skill_invocations(skill_name, triggered);

-- alpha_evolution_outcomes: lookup by user, skill, proposal
CREATE INDEX idx_alpha_evo_user ON alpha_evolution_outcomes(user_id);
CREATE INDEX idx_alpha_evo_skill ON alpha_evolution_outcomes(skill_name);
CREATE INDEX idx_alpha_evo_proposal ON alpha_evolution_outcomes(proposal_id);
CREATE INDEX idx_alpha_evo_timestamp ON alpha_evolution_outcomes(timestamp);
```

---

## 3. Upload Payload Contract

The TypeScript interfaces are defined in `cli/selftune/alpha-upload-contract.ts`. The key types:

- **`AlphaUploadEnvelope`** --- the top-level wrapper sent in each HTTP request. Contains metadata (user_id, agent_type, selftune_version, schema_version) and a typed payload array. The `payload_type` discriminator (`"sessions" | "invocations" | "evolution"`) tells the Worker which D1 table to target.

- **`AlphaSessionPayload`** --- maps to `alpha_sessions`. The `workspace_hash` field contains a SHA256 of the workspace path (never the raw path). `skills_triggered` is a string array that the Worker serializes to `skills_triggered_json`.

- **`AlphaInvocationPayload`** --- maps to `alpha_skill_invocations`. The `query_text` field stores the raw query text for the friendly alpha cohort. `triggered` is a boolean (the Worker converts to INTEGER for D1).

- **`AlphaEvolutionPayload`** --- maps to `alpha_evolution_outcomes`. Pass rates are nullable (null when the evolution run did not measure them).

- **`AlphaUploadResult`** --- the Worker's response. Reports accepted/rejected counts and error strings for debugging.

Field-to-column mapping is 1:1 with these exceptions:
- `skills_triggered` (string array) maps to `skills_triggered_json` (TEXT, JSON-serialized)
- `triggered` (boolean) maps to `triggered` (INTEGER, 0/1)
- `deployed`/`rolled_back` (boolean) map to INTEGER columns
- `user_id` and `uploaded_at` are added by the envelope, not repeated in each payload item

---

## 4. Upload Timing

**Recommendation: periodic batch upload, not immediate.**

Uploads happen at two touchpoints:

1. **On each `selftune orchestrate` run.** After sync completes and before evolution begins, the orchestrate loop checks for pending upload queue items and flushes them. This piggybacks on the existing orchestrate cadence (typically cron-scheduled every 1-4 hours).

2. **Explicit `selftune sync --upload`.** A future `--upload` flag on the sync command triggers an immediate flush. This gives agents a way to force-upload without running a full orchestrate cycle.

**Rationale for batch over immediate:**

- **Alpha volume is low.** Tens of users generating hundreds of records per day. Real-time streaming adds complexity without proportional value.
- **Reduces noise.** Batching naturally deduplicates records that might be written multiple times during a session (e.g., skill_usage records appended by hooks then reconciled by sync).
- **Aligns with orchestrate cadence.** The orchestrate loop already reads local SQLite, runs evolution, and writes results. Adding an upload step is a natural extension of this pipeline.
- **Failure isolation.** If D1 is unreachable, the upload fails silently and retries next cycle. No impact on local selftune operation.

**What NOT to do:**
- Do not upload from hooks (too latency-sensitive, runs in the critical path of user prompts).
- Do not upload from the dashboard server (it is a read-only query surface).
- Do not upload on every SQLite write (too frequent, creates thundering herd on D1 for multi-skill users).

---

## 5. Queue/Retry Model

### Local upload queue

A local `upload_queue` table in the existing selftune SQLite database (NOT in D1) stages records for upload. This table is added to `cli/selftune/localdb/schema.ts` in the implementation phase (not in this spike).

```sql
CREATE TABLE upload_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_type    TEXT NOT NULL,  -- 'sessions' | 'invocations' | 'evolution'
  payload_json    TEXT NOT NULL,  -- JSON-serialized array of payload items
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  sent_at         TEXT
);

CREATE INDEX idx_upload_queue_status ON upload_queue(status);
CREATE INDEX idx_upload_queue_created ON upload_queue(created_at);
```

### Enqueue flow

1. During `orchestrate` or `sync --upload`, the upload module queries local SQLite for records not yet uploaded (tracked via a `last_upload_watermark` in `_meta`).
2. Records are batched into envelopes of up to **100 records** per payload type.
3. Each batch is inserted into `upload_queue` as a single row with `status = 'pending'`.

### Flush flow

1. The flush function queries `upload_queue WHERE status IN ('pending', 'failed') AND attempts < 5` ordered by `created_at ASC`.
2. For each queued item, it constructs an `AlphaUploadEnvelope` and POSTs to the Worker endpoint.
3. On success (`AlphaUploadResult.success === true`): update `status = 'sent'`, set `sent_at`.
4. On failure: increment `attempts`, set `last_attempt_at` and `last_error`, set `status = 'failed'`.

### Retry with exponential backoff

When retrying failed items within a single flush cycle:

| Attempt | Delay before retry |
|---------|-------------------|
| 1 | 1 second |
| 2 | 2 seconds |
| 3 | 4 seconds |
| 4 | 8 seconds |
| 5 | 16 seconds |

After 5 failed attempts, the queue item stays at `status = 'failed'` and is not retried automatically. A future `selftune alpha retry` command (not in this spike) could reset failed items.

### Batch size limits

- Maximum **100 records** per envelope (per payload_type).
- If a local query returns more than 100 records for a payload type, they are split into multiple queue items.
- This keeps individual HTTP requests small (estimated <50KB per envelope at 100 invocation records).

---

## 6. Consent Enforcement

### Local enforcement

Before any network call, the upload module performs this check:

```
config = readFreshConfig()  // NOT cached, read from disk each time
if config.alpha?.enrolled !== true:
    return  // silently skip upload
```

Reading config fresh from disk on every upload attempt means a user (or their agent) can unenroll at any time by setting `config.alpha.enrolled = false` or removing the `alpha` key. The next upload cycle respects the change immediately.

### Server-side enforcement

The Cloudflare Worker validates every upload:

1. Extract `user_id` from the `AlphaUploadEnvelope`.
2. Query `alpha_users WHERE user_id = ?`.
3. If the user does not exist or has been deactivated, reject the entire envelope with an appropriate error in `AlphaUploadResult.errors`.
4. Update `alpha_users.last_upload_at` on successful writes.

### Future: data deletion

A future `selftune alpha delete-data` command (not in this spike) will:
- Call a Worker endpoint that deletes all records for the user's `user_id` across all four tables.
- Remove the `alpha` config block locally.
- Confirm deletion to the agent.

This aligns with the principle that alpha enrollment is fully reversible.

---

## 7. Privacy Model

### Data minimization

The alpha pipeline uploads only the fields needed for alpha analysis, but it does include raw query text for explicitly consented users:

| Data category | What is uploaded | What is NOT uploaded |
|---------------|-----------------|---------------------|
| Queries | Raw query text | Full transcript bodies outside the captured prompt/query text |
| Workspace paths | SHA256 hash | Raw filesystem paths |
| File contents | Nothing | Nothing |
| Conversation text | Prompt/query text only | Full conversation transcripts |
| Code | Nothing | Nothing |
| File paths | Only if the user typed them into prompt/query text | Structured file-path fields |
| Session IDs | Session ID (opaque UUID) | N/A |

### Hashing

One field uses SHA256 hashing to enable grouping without revealing raw values:

- **`workspace_hash`**: SHA256 of the workspace path. Enables per-project analysis without revealing directory structures.

### What is explicitly excluded

- No file contents of any kind
- No transcript text beyond the captured prompt/query text
- No code snippets or diffs
- No structured file paths (workspace paths are hashed)
- No environment variables or shell history
- No tool input/output content

---

## 8. Relationship to `contribute/`

### Distinct purposes

The `contribute/` system and the alpha upload pipeline exist for different reasons:

**`contribute/`** is a community-building mechanism. Users manually run `selftune contribute` to share anonymized skill evaluation data with the broader selftune community via GitHub PRs. The data helps skill authors understand how their skills perform across different users. It is opt-in per invocation, requires explicit confirmation, and flows through GitHub's review process.

**Alpha upload** is a product telemetry pipeline for the alpha cohort. It runs automatically (when enrolled), collects session-level and invocation-level data, and stores it in a centralized database for aggregate analysis. The data helps the selftune team understand adoption patterns, evolution effectiveness, and skill trigger reliability across the alpha user base.

### Shared infrastructure

Despite their different purposes, both systems benefit from shared components:

- **Schema conventions.** Both follow the same timestamp format (ISO 8601), ID format (UUID v4), and nullable field conventions as the local SQLite schema.
- **Config reading.** Both read from `~/.selftune/config.json` for agent_type and version information. The alpha pipeline adds the `alpha.enrolled` check.

### Non-shared concerns

- **Transport.** `contribute/` uses the GitHub API; alpha uses HTTPS to a Cloudflare Worker. No shared transport code.
- **Bundling.** `contribute/` assembles a `ContributionBundle` with eval entries, grading summaries, and evolution summaries for a single skill. Alpha upload sends `AlphaUploadEnvelope` instances with raw session/invocation/evolution records across all skills. Different shapes, different aggregation levels.
- **Retry.** `contribute/` has no retry mechanism (it is a one-shot PR creation). Alpha upload uses the local queue with exponential backoff.

---

## Appendix: Open Questions for Post-Spike

1. **Authentication.** How does the Worker verify that the `user_id` in the envelope matches the actual caller? Options: API key per user, signed JWTs issued at enrollment, or Cloudflare Access.
2. **Rate limiting.** Should the Worker enforce per-user rate limits beyond the 5-attempt backoff? Probably yes for abuse prevention.
3. **Data retention.** How long are alpha records kept in D1? Rolling 90-day window? Indefinite during alpha?
4. **Schema evolution.** When `schema_version` advances beyond `alpha-1.0`, how does the Worker handle mixed-version payloads? Likely: accept both, migrate on read.
5. **Operator dashboard.** An operator-facing view of alpha data (upload rates, error rates, cohort size) is deferred to a separate spike.
