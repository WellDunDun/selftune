import type { Database } from "bun:sqlite";
import { Option, Schema } from "effect";

import { checkSkillSetCollisionReadiness } from "@selftune/runtime/skill-sets/collision-readiness";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "@selftune/runtime/localdb/queries";

const decodeSkillNames = Schema.decodeUnknownOption(
  Schema.Struct({
    skillNames: Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(50)),
  }),
);

export function handleSkillSetCollisionReadiness(body: Schema.Json, db: Database): Response {
  const input = decodeSkillNames(body);
  const skillNames = Option.isSome(input) ? input.value.skillNames.map((name) => name.trim()) : [];
  if (
    skillNames.length === 0 ||
    skillNames.some((name) => name.length === 0) ||
    new Set(skillNames).size !== skillNames.length
  ) {
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
