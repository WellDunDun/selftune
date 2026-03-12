import { useCallback, useEffect, useState } from "react";
import { fetchOverview, fetchSkillEvaluations } from "../api";
import type { EvaluationRecord, MonitoringSnapshot, OverviewPayload } from "../types";

type LoadState = "loading" | "ready" | "error" | "not-found";

export interface SkillReportData {
  name: string;
  snapshot: MonitoringSnapshot | null;
  evaluations: EvaluationRecord[];
  overview: OverviewPayload;
}

export function useSkillReport(skillName: string | undefined) {
  const [data, setData] = useState<SkillReportData | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!skillName) return;
    setState("loading");
    setError(null);
    try {
      const [overview, evaluations] = await Promise.all([
        fetchOverview(),
        fetchSkillEvaluations(skillName),
      ]);

      const snapshot = overview.computed.snapshots[skillName] ?? null;
      if (!snapshot && evaluations.length === 0) {
        setState("not-found");
        return;
      }

      setData({ name: skillName, snapshot, evaluations, overview });
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skill data");
      setState("error");
    }
  }, [skillName]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, state, error, retry: load };
}
