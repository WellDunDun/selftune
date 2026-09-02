import type { Database } from "bun:sqlite";

import { checkSkillSetCollisionReadiness } from "@selftune/runtime/skill-sets/collision-readiness";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "@selftune/runtime/localdb/queries";

function readSkillNames(body: Record<string, unknown>): string[] | null {
  const value = body.skillNames;
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) return null;
  if (!value.every((name) => typeof name === "string" && name.trim().length > 0)) return null;
  const names = value.map((name) => name.trim());
  return new Set(names).size === names.length ? names : null;
}

export function handleSkillSetCollisionReadiness(
  body: Record<string, unknown>,
  db: Database,
): Response {
  const skillNames = readSkillNames(body);
  if (!skillNames) {
    return Response.json(
      {
        success: false,
        error: "skillNames must contain 2 to 50 distinct, non-empty skill names.",
      },
      { status: 400 },
    );
  }

  const report = checkSkillSetCollisionReadiness({
    skillNames,
    telemetry: querySessionTelemetry(db),
    usage: querySkillUsageRecords(db),
    queries: queryQueryLog(db),
  });
  return Response.json({ success: true, report });
}
