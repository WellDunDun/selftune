import { useCallback, useEffect, useRef, useState } from "react";
import { createSSEConnection, fetchOverview } from "../api";
import type { OverviewPayload } from "../types";

type LoadState = "loading" | "ready" | "error";

export function useOverview() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const sseCleanup = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const payload = await fetchOverview();
      setData(payload);
      setState("ready");

      // Start SSE for live updates after initial load
      if (sseCleanup.current) sseCleanup.current();
      sseCleanup.current = createSSEConnection((fresh) => {
        setData(fresh);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (sseCleanup.current) sseCleanup.current();
    };
  }, [load]);

  return { data, state, error, retry: load };
}
