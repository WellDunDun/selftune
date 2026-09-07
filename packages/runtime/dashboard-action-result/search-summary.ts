import type { CliJsonOutput } from "../utils/json-output.js";
import type { DashboardSearchRunSummary } from "../dashboard-contract.js";
import { readNumber, readObject, readString } from "./package-readers.js";

export function extractSearchRunSummary(parsed: CliJsonOutput): DashboardSearchRunSummary | null {
  const searchId = readString(parsed["search_id"]);
  if (!searchId) return null;

  const provenance = parsed["provenance"];
  const prov = readObject(provenance);
  const surfacePlan = readObject(prov?.["surface_plan"]);

  return {
    search_id: searchId,
    parent_candidate_id: readString(parsed["parent_candidate_id"]),
    winner_candidate_id: readString(parsed["winner_candidate_id"]),
    winner_rationale: readString(parsed["winner_rationale"]),
    candidates_evaluated: readNumber(parsed["candidates_evaluated"]) ?? 0,
    frontier_size: prov ? (readNumber(prov["frontier_size"]) ?? 0) : 0,
    parent_selection_method: prov
      ? (readString(prov["parent_selection_method"]) ?? "unknown")
      : "unknown",
    surface_plan: surfacePlan
      ? {
          routing_count: readNumber(surfacePlan["routing_count"]) ?? 0,
          body_count: readNumber(surfacePlan["body_count"]) ?? 0,
          weakness_source: readString(surfacePlan["weakness_source"]) ?? "unknown",
          routing_weakness: readNumber(surfacePlan["routing_weakness"]),
          body_weakness: readNumber(surfacePlan["body_weakness"]),
        }
      : undefined,
  };
}
