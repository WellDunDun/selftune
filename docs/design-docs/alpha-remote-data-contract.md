<!-- Verified: 2026-04-01 -->

# Alpha Remote Data Contract — Cloud API V2 Push, Upload Queue, Auth Model

**Status:** Active
**Created:** 2026-03-18
**Updated:** 2026-04-01
**Type:** Design document

---

## 1. Overview

### What the alpha remote pipeline does

The alpha remote pipeline enables opted-in selftune users to upload consent-based telemetry data to the selftune cloud API. This data powers aggregate analysis across the alpha cohort: which skills trigger reliably, which evolution proposals improve outcomes, and where the selftune feedback loop breaks down across real-world usage patterns.

The pipeline is batch-oriented and asynchronous. Local SQLite remains the source of truth. Uploads happen periodically during `sync` and `orchestrate` runs, or explicitly through `selftune alpha upload`, not in real time.

### Why the cloud API

Alpha uploads target the existing selftune cloud API's V2 push endpoint (`POST /api/v1/push`) rather than a standalone service. This approach was chosen over a dedicated Cloudflare Worker/D1 setup because:

- **Shared infrastructure.** The cloud API already handles authentication, rate limiting, and data storage in Neon Postgres. No separate service to deploy and maintain.
- **Canonical schema.** The V2 push endpoint accepts canonical records (sessions, prompts, skill_invocations, execution_facts, evolution_evidence) that align with selftune's data model. No impedance mismatch between local and remote schemas.
- **Single auth model.** Users authenticate with `st_live_*` API keys via Bearer header — the same mechanism used for all cloud API interactions.
- **Low cost for alpha volume.** The existing cloud infrastructure handles the expected alpha cohort (tens of users, thousands of records per day) without additional cost.

### Relationship to the existing contribution surfaces

The current product has three distinct sharing surfaces:
- `selftune contribute` — manual community contribution bundle export
- `selftune contributions` — local creator-directed sharing preferences
- `selftune alpha upload` — user -> own cloud / alpha telemetry upload

The `contribute/` system and the alpha upload pipeline serve different purposes but now share the same cloud API backend:

| Dimension            | `contribute/`                             | Alpha upload                                                               |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| **Purpose**          | Community sharing of anonymized eval data | Automatic telemetry for alpha cohort analysis                              |
| **Trigger**          | Manual (`selftune contribute`)            | Automatic (each `sync` / `orchestrate` run when enrolled)                  |
| **Transport**        | HTTPS to cloud API                        | HTTPS to cloud API (`POST /api/v1/push`)                                   |
| **Storage**          | Neon Postgres (canonical tables)          | Neon Postgres (canonical tables)                                           |
| **Consent model**    | Per-invocation confirmation               | Enrollment flag in config (`config.alpha.enrolled`) + API key              |
| **Data granularity** | Skill-level bundles with eval entries     | Session-level, invocation-level, evolution-level V2 canonical records      |
| **Privacy level**    | Conservative or aggressive sanitization   | Explicit alpha consent for raw prompt/query text plus structured telemetry |

Both systems target the same cloud API, but alpha upload is automatic (when enrolled and an API key is configured) while community contribution requires manual invocation and confirmation.

`selftune contributions` is intentionally separate: it stores future creator-directed sharing preferences locally and does not yet change alpha-upload behavior by itself.
The current local creator-directed contribution groundwork also stays separate from alpha upload:

- approved skills can now stage privacy-safe creator-directed relay signals into SQLite during `sync`
- those staged rows do **not** ride the alpha upload queue
- they now flush explicitly through `selftune contributions upload` to a dedicated relay endpoint
- cloud relay delivery will be a later pipeline layered on top of the existing remote architecture

---

## 2. Endpoint Configuration

### Target endpoint

Alpha uploads are sent to the cloud API's V2 push endpoint:

```text
POST https://api.selftune.dev/api/v1/push
```

### Environment override

The endpoint can be overridden with the `SELFTUNE_ALPHA_ENDPOINT` environment variable:

```bash
export SELFTUNE_ALPHA_ENDPOINT="https://staging-api.selftune.dev/api/v1/push"
```

Default: `https://api.selftune.dev/api/v1/push`

---

## 3. Authentication

### API key model

Each alpha user authenticates with an `st_live_*` API key, provisioned automatically via the device-code flow:

1. User runs `selftune init --alpha --alpha-email <email>`
2. CLI requests a device code and opens the browser for approval
3. On approval, the CLI receives and stores the API key, cloud_user_id, and org_id automatically

### HTTP auth

Every upload request includes the API key as a Bearer token:

```text
Authorization: Bearer st_live_abc123...
```

The cloud API validates the key, identifies the user, and associates uploaded records with their account.

### Key storage

The API key is stored in `~/.selftune/config.json` under the `alpha` block:

```json
{
  "alpha": {
    "enrolled": true,
    "user_id": "a1b2c3d4-...",
    "api_key": "st_live_abc123...",
    "email": "user@example.com"
  }
}
```

---

## 4. V2 Canonical Payload Format

### Schema version

All upload payloads use `schema_version: "2.0"` and contain canonical records that map directly to the cloud API's Postgres tables.

### Record types

The V2 push payload contains typed canonical records:

| Record type          | Description                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`           | Session summaries with platform, model, timing, and skill trigger metadata                                                              |
| `prompts`            | User prompt/query records with raw text (alpha consent required)                                                                        |
| `skill_invocations`  | Skill trigger/miss records with confidence, mode, and query context                                                                     |
| `execution_facts`    | Tool usage, error counts, and execution metadata (deterministic `execution_fact_id` generated during staging for records that lack one) |
| `evolution_evidence` | Evolution proposal outcomes, pass rate changes, deploy/rollback status (deterministic `evidence_id` generated during staging)           |
| `orchestrate_runs`   | Orchestrate run reports with sync/evolve/watch phase summaries                                                                          |

### Payload envelope

Each HTTP request sends an envelope containing metadata and a batch of canonical records:

```json
{
  "schema_version": "2.0",
  "user_id": "a1b2c3d4-...",
  "agent_type": "claude_code",
  "selftune_version": "0.2.7",
  "records": [
    { "type": "sessions", "data": { ... } },
    { "type": "skill_invocations", "data": { ... } }
  ]
}
```

The TypeScript interfaces are defined in `cli/selftune/alpha-upload-contract.ts` (queue infrastructure types and `PushUploadResult`). The V2 payload shape is validated by `PushPayloadV2Schema` (Zod) with `min(0)` arrays.

### Canonical upload staging

Before payloads are built, records are staged into a local `canonical_upload_staging` SQLite table by `cli/selftune/alpha-upload/stage-canonical.ts`. This module reads canonical records from SQLite by default (or a JSONL override only for explicit recovery/debugging), plus evolution evidence and orchestrate runs from SQLite, then writes them into the staging table with deterministic IDs:

- **`execution_fact_id`** — generated deterministically during staging for records that lack one (hash of session_id + tool + timestamp)
- **`evidence_id`** — generated deterministically during staging for evolution evidence records (hash of proposal_id + target + skill + timestamp)

The staging table uses a single monotonic cursor, so `build-payloads.ts` reads only unstaged records on each cycle. This avoids re-scanning the full SQLite-backed canonical history. If a malformed staged row is encountered, payload assembly stops before that row and holds the cursor at the last valid sequence so corrupted data is not silently skipped.

### Cloud-side lossless ingest

The cloud API stores every push request in a `raw_pushes` table before normalizing into canonical tables. This provides:

- **Lossless ingest** — no data is lost even if normalization logic changes
- **Partial push acceptance** — unresolved references are stored in raw_pushes and resolved later
- **Retry safety** — natural-key UNIQUE constraints with `onConflictDoNothing` make duplicate pushes idempotent

---

## 5. Response Handling

The cloud API returns standard HTTP status codes:

| Status                  | Meaning                              | Client behavior                               |
| ----------------------- | ------------------------------------ | --------------------------------------------- |
| `201 Created`           | Records accepted and stored          | Mark queue item as `sent`                     |
| `409 Conflict`          | Duplicate records (already uploaded) | Treat as success, mark `sent`                 |
| `429 Too Many Requests` | Rate limited                         | Retryable — increment attempts, apply backoff |
| `401 Unauthorized`      | Invalid or missing API key           | Non-retryable — mark `failed`, log auth error |
| `403 Forbidden`         | Key valid but user not authorized    | Non-retryable — mark `failed`, log auth error |
| `5xx`                   | Server error                         | Retryable — increment attempts, apply backoff |

---

## 6. Upload Timing

**Recommendation: periodic batch upload, not immediate.**

Uploads happen at two touchpoints:

1. **On each `selftune orchestrate` run.** After sync completes and before evolution begins, the orchestrate loop checks for pending upload queue items and flushes them. This piggybacks on the existing orchestrate cadence (typically cron-scheduled every 1-4 hours).

2. **On each `selftune sync` run when alpha is enrolled.** Sync replays native source data into SQLite, then runs an upload cycle so the cloud stays current between orchestrate runs.

3. **Explicit `selftune alpha upload`.** This gives agents a way to force-upload or preview a dry run without running a full orchestrate cycle.

**Rationale for batch over immediate:**

- **Alpha volume is low.** Tens of users generating hundreds of records per day. Real-time streaming adds complexity without proportional value.
- **Reduces noise.** Batching naturally deduplicates records that might be written multiple times during a session (e.g., skill_usage records appended by hooks then reconciled by sync).
- **Aligns with orchestrate cadence.** The orchestrate loop already reads local SQLite, runs evolution, and writes results. Adding an upload step is a natural extension of this pipeline.
- **Failure isolation.** If the cloud API is unreachable, the upload fails silently and retries next cycle. No impact on local selftune operation.

**What NOT to do:**

- Do not upload from hooks (too latency-sensitive, runs in the critical path of user prompts).
- Do not upload from the dashboard server (it is a read-only query surface).
- Do not upload on every SQLite write (too frequent, creates thundering herd for multi-skill users).

---

## 7. Queue/Retry Model

### Local upload queue

A local `upload_queue` table in the existing selftune SQLite database stages records for upload. This table is defined in `cli/selftune/localdb/schema.ts`.

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

1. During `sync`, `orchestrate`, or `selftune alpha upload`, the upload module stages canonical SQLite rows into `canonical_upload_staging` and advances from that staging table's monotonic sequence/cursor.
2. Records are batched into envelopes of up to **100 records** per payload type.
3. Each batch is inserted into `upload_queue` as a single row with `status = 'pending'`.

### Flush flow

1. `flushQueue()` selects rows with `status = 'pending'` ordered by `created_at ASC`.
2. For each pending item, it POSTs the stored V2 push envelope to `https://api.selftune.dev/api/v1/push` with the Bearer API key.
3. Retryable failures (`429`, `5xx`) are retried with exponential backoff inside the same `flushQueue()` run.
4. Success (`201` or `409`) is terminal: set `status = 'sent'` and `sent_at`.
5. Exhausted retryable failures and non-retryable auth failures (`401`, `403`) are terminal: increment `attempts`, set `last_attempt_at` / `last_error`, and leave the row at `status = 'failed'`.

### Retry with exponential backoff

When retrying failed items within a single flush cycle:

| Attempt | Delay before retry |
| ------- | ------------------ |
| 1       | 1 second           |
| 2       | 2 seconds          |
| 3       | 4 seconds          |
| 4       | 8 seconds          |
| 5       | 16 seconds         |

After 5 failed attempts, the queue item stays at `status = 'failed'` and is not retried automatically. A future `selftune alpha retry` command could reset failed items.

### Batch size limits

- Maximum **100 records** per envelope (per payload_type).
- If a local query returns more than 100 records for a payload type, they are split into multiple queue items.
- This keeps individual HTTP requests small (estimated <50KB per envelope at 100 invocation records).

---

## 8. Consent Enforcement

### Local enforcement

Before any network call, the upload module performs this check:

```python
config = readFreshConfig()  // NOT cached, read from disk each time
if config.alpha?.enrolled !== true:
    return  // silently skip upload
if !config.alpha?.api_key:
    return  // no API key configured, skip upload
```

Reading config fresh from disk on every upload attempt means a user (or their agent) can unenroll at any time by setting `config.alpha.enrolled = false` or removing the `alpha` key. The next upload cycle respects the change immediately.

### Server-side enforcement

The cloud API validates every upload:

1. Extract the API key from the `Authorization: Bearer` header.
2. Look up the associated user account.
3. If the key is invalid or the user has been deactivated, return 401/403.
4. On successful writes, update the user's `last_upload_at` timestamp.

### Future: data deletion

A future `selftune alpha delete-data` command will:

- Call a cloud API endpoint that deletes all records for the user's account.
- Remove the `alpha` config block locally.
- Confirm deletion to the agent.

This aligns with the principle that alpha enrollment is fully reversible.

---

## 9. Privacy Model

### Data minimization

The alpha pipeline uploads only the fields needed for alpha analysis, but it does include raw query text for explicitly consented users:

| Data category     | What is uploaded                                   | What is NOT uploaded                                          |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Queries           | Raw query text (in `raw_source_ref.metadata`)      | Full transcript bodies outside the captured prompt/query text |
| Workspace paths   | Workspace path (in V2 canonical records)           | N/A                                                           |
| File contents     | Nothing                                            | Nothing                                                       |
| Conversation text | Prompt/query text only                             | Full conversation transcripts                                 |
| Code              | Nothing                                            | Nothing                                                       |
| File paths        | Only if the user typed them into prompt/query text | Structured file-path fields                                   |
| Session IDs       | Session ID (opaque UUID)                           | N/A                                                           |

### What is explicitly excluded

- No file contents of any kind
- No transcript text beyond the captured prompt/query text
- No code snippets or diffs
- No environment variables or shell history
- No tool input/output content

---

## Appendix: Design Decision — Cloud API over Standalone Worker

The initial design direction evaluated a standalone Cloudflare Worker backed by D1 (SQLite at the edge). This was replaced with direct integration into the existing cloud API for these reasons:

1. **Reduced operational surface.** One service to monitor, not two.
2. **Unified auth.** API keys work the same way for all cloud interactions.
3. **Schema convergence.** V2 canonical records are the shared language between local and cloud — no separate D1 schema to maintain.
4. **Future-proof.** As selftune moves toward a full cloud product, alpha data lives in the same Postgres tables that power the cloud dashboard.
