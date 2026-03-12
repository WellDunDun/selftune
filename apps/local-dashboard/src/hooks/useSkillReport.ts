import { useCallback, useEffect, useRef, useState } from "react";
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
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestVersion.current;
    if (!skillName) {
      setState("error");
      setError("No skill name provided");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const [overview, evaluations] = await Promise.all([
        fetchOverview(),
        fetchSkillEvaluations(skillName),
      ]);

      if (currentRequest !== requestVersion.current) return;

      const snapshot = overview.computed.snapshots[skillName] ?? null;
      if (!snapshot && evaluations.length === 0) {
        setState("not-found");
        return;
      }

      setData({ name: skillName, snapshot, evaluations, overview });
      setState("ready");
    } catch (err) {
      if (currentRequest !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : "Failed to load skill data");
      setState("error");
    }
  }, [skillName]);

  useEffect(() => {
    void load();
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  return { data, state, error, retry: load };
}
