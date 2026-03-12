import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSkillReport, NotFoundError } from "../api";
import type { SkillReportResponse } from "../types";

type LoadState = "loading" | "ready" | "error" | "not-found";

export function useSkillReport(skillName: string | undefined) {
  const [data, setData] = useState<SkillReportResponse | null>(null);
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
      const report = await fetchSkillReport(skillName);

      if (currentRequest !== requestVersion.current) return;

      if (report.usage.total_checks === 0 && report.evidence.length === 0) {
        setState("not-found");
        return;
      }

      setData(report);
      setState("ready");
    } catch (err) {
      if (currentRequest !== requestVersion.current) return;
      if (err instanceof NotFoundError) {
        setState("not-found");
        return;
      }
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
