import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOverview } from "../api";
import type { OverviewResponse } from "../types";

type LoadState = "loading" | "ready" | "error";

const POLL_INTERVAL_MS = 15_000;

export function useOverview() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setState((prev) => (prev === "ready" ? prev : "loading"));
    setError(null);
    try {
      const payload = await fetchOverview();
      setData(payload);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();

    pollTimer.current = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [load]);

  return { data, state, error, retry: load };
}
