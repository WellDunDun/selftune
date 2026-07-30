import { resolve } from "node:path";

import { normalizeSkillText } from "./classification.js";
import type {
  SkillIntelligenceObservationGroups,
  SkillIntelligenceSkillObservationGroup,
  SkillIntelligenceTriggeredObservationRow,
  TrustedSkillObservationRow,
} from "./types.js";

export const MAX_REPORT_QUERY_TEXT_CHARS = 4_096;

function skillId(name: string): string {
  return name.trim().toLowerCase();
}

interface MutableSkillObservationGroup {
  observed_count: number;
  triggered_count: number;
  query_texts: string[];
  skill_paths: Map<string, number>;
  normalized_queries: Set<string>;
}

export function aggregateSkillIntelligenceObservations(
  observations: Iterable<TrustedSkillObservationRow>,
): SkillIntelligenceObservationGroups {
  const mutableBySkillId = new Map<string, MutableSkillObservationGroup>();
  const triggeredObservations: SkillIntelligenceTriggeredObservationRow[] = [];
  const orderedBySession = new Map<string, SkillIntelligenceTriggeredObservationRow[]>();

  for (const row of observations) {
    const id = skillId(row.skill_name);
    let group = mutableBySkillId.get(id);
    if (!group) {
      group = {
        observed_count: 0,
        triggered_count: 0,
        query_texts: [],
        skill_paths: new Map(),
        normalized_queries: new Set(),
      };
      mutableBySkillId.set(id, group);
    }
    group.observed_count += 1;
    group.query_texts.push(row.query_text);
    const normalizedQueryIdentity = row.query_fingerprint ?? normalizeSkillText(row.query_text);
    if (normalizedQueryIdentity) group.normalized_queries.add(normalizedQueryIdentity);

    if (row.triggered !== 1) continue;
    group.triggered_count += 1;
    const triggeredObservation = {
      skill_name: row.skill_name,
      skill_path: row.skill_path,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      invocation_mode: row.invocation_mode,
      query_text: row.query_text,
    };
    triggeredObservations.push(triggeredObservation);
    if (row.skill_path) {
      const path = resolve(row.skill_path);
      group.skill_paths.set(path, (group.skill_paths.get(path) ?? 0) + 1);
    }
    const sessionRows = orderedBySession.get(row.session_id);
    if (sessionRows) sessionRows.push(triggeredObservation);
    else orderedBySession.set(row.session_id, [triggeredObservation]);
  }

  const idsBySession = new Map<string, string[]>();
  for (const [sessionId, rows] of orderedBySession) {
    rows.sort((left, right) => (left.occurred_at ?? "").localeCompare(right.occurred_at ?? ""));
    const ids: string[] = [];
    for (const row of rows) {
      const id = skillId(row.skill_name);
      if (!ids.includes(id)) ids.push(id);
    }
    idsBySession.set(sessionId, ids);
  }

  const bySkillId = new Map<string, SkillIntelligenceSkillObservationGroup>();
  for (const [id, group] of mutableBySkillId) {
    bySkillId.set(id, {
      observed_count: group.observed_count,
      triggered_count: group.triggered_count,
      query_texts: group.query_texts,
      skill_paths: group.skill_paths,
      distinct_normalized_query_count: group.normalized_queries.size,
    });
  }

  return {
    bySkillId,
    triggeredObservations,
    orderedBySession,
    idsBySession,
  };
}
