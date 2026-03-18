import type {
  AlphaUploadEnvelope,
  AlphaUploadResult,
  AlphaSessionPayload,
  AlphaInvocationPayload,
  AlphaEvolutionPayload,
} from "./types";

/**
 * Ingest a validated AlphaUploadEnvelope into D1.
 *
 * Uses D1 batch API for atomicity: user upsert + all payload inserts
 * execute in a single batch call.
 */
export async function ingestEnvelope(
  db: D1Database,
  envelope: AlphaUploadEnvelope
): Promise<AlphaUploadResult> {
  try {
    const stmts: D1PreparedStatement[] = [];

    // Upsert alpha_users — first_seen_at only set on initial insert
    const userUpsert = db
      .prepare(
        `INSERT INTO alpha_users (user_id, first_seen_at, last_upload_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_upload_at = excluded.last_upload_at`
      )
      .bind(envelope.user_id, envelope.uploaded_at, envelope.uploaded_at);
    stmts.push(userUpsert);

    // Build payload-specific inserts
    switch (envelope.payload_type) {
      case "sessions":
        for (const p of envelope.payload as AlphaSessionPayload[]) {
          stmts.push(buildSessionInsert(db, envelope.user_id, p, envelope.uploaded_at));
        }
        break;

      case "invocations":
        for (const p of envelope.payload as AlphaInvocationPayload[]) {
          stmts.push(buildInvocationInsert(db, envelope.user_id, p, envelope.uploaded_at));
        }
        break;

      case "evolution":
        for (const p of envelope.payload as AlphaEvolutionPayload[]) {
          stmts.push(buildEvolutionInsert(db, envelope.user_id, p, envelope.uploaded_at));
        }
        break;
    }

    await db.batch(stmts);

    return {
      success: true,
      accepted: envelope.payload.length,
      rejected: 0,
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      accepted: 0,
      rejected: envelope.payload.length,
      errors: [`Ingest failed: ${message}`],
    };
  }
}

function buildSessionInsert(
  db: D1Database,
  userId: string,
  p: AlphaSessionPayload,
  uploadedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alpha_sessions
       (user_id, session_id, platform, model, workspace_hash,
        started_at, ended_at, total_tool_calls, assistant_turns,
        errors_encountered, skills_triggered_json, completion_status, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      p.session_id,
      p.platform,
      p.model,
      p.workspace_hash,
      p.started_at,
      p.ended_at,
      p.total_tool_calls,
      p.assistant_turns,
      p.errors_encountered,
      JSON.stringify(p.skills_triggered),
      p.completion_status,
      uploadedAt
    );
}

function buildInvocationInsert(
  db: D1Database,
  userId: string,
  p: AlphaInvocationPayload,
  uploadedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alpha_invocations
       (user_id, session_id, occurred_at, skill_name, invocation_mode,
        triggered, confidence, query_text, skill_scope, source, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      p.session_id,
      p.occurred_at,
      p.skill_name,
      p.invocation_mode,
      p.triggered ? 1 : 0,
      p.confidence,
      p.query_text,
      p.skill_scope,
      p.source,
      uploadedAt
    );
}

function buildEvolutionInsert(
  db: D1Database,
  userId: string,
  p: AlphaEvolutionPayload,
  uploadedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alpha_evolution_outcomes
       (user_id, proposal_id, skill_name, action,
        before_pass_rate, after_pass_rate, net_change,
        deployed, rolled_back, timestamp, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      p.proposal_id,
      p.skill_name,
      p.action,
      p.before_pass_rate,
      p.after_pass_rate,
      p.net_change,
      p.deployed ? 1 : 0,
      p.rolled_back ? 1 : 0,
      p.timestamp,
      uploadedAt
    );
}
